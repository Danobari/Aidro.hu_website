import type { Config, Context } from "@netlify/functions";
import { Agent, createClient } from "@relevanceai/sdk";

const PROJECT_ID = "28511a9a-43eb-471c-8753-c7b7ff634074";

const AGENT_IDS: Record<string, string> = {
  general: "6229139e-ae08-461a-b461-812fe6c60836",
  training: "4c99cbe3-0fac-4957-a1d5-2fbd8b7ab280",
  agents: "e7c3ead5-2f7e-4cc1-a2a5-24cb3f2cbec6",
  consulting: "243ae998-6f0f-492a-9f4c-70cc4c469f70",
  sprint: "5135a415-4351-46ef-8899-b6e1492bf59a",
  documents: "55355bd0-6102-4320-9d42-1a4d6863a184",
  copilot: "10f40248-f32f-4cde-963a-d67c90340869",
};

// Colchón para relojes desalineados entre esta función y el backend de
// Relevance: al fijar "sentAt" restamos unos segundos para no excluir por
// error el mensaje que sí acabamos de generar.
const CLOCK_SKEW_BUFFER_MS = 5000;

type Session = { task: any; agent: any; message?: string; error?: string; done: boolean; sentAt: Date };
const sessions = new Map<string, Session>();

function env(name: string, fallback = "") {
  const netlify = (globalThis as any).Netlify;
  return netlify?.env?.get?.(name) || process.env[name] || fallback;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

let clientInitialized = false;

function getConfig() {
  const apiKey = env("RELEVANCE_API_KEY_aidro") || env("RELEVANCE_API_KEY");
  const region = env("RELEVANCE_REGION", "bcbe5a");
  if (!apiKey) throw new Error("Falta configurar RELEVANCE_API_KEY_aidro en el entorno de Netlify.");
  // createClient() solo puede llamarse una vez por proceso (lanza si ya existe
  // un cliente default); en una función "warm" de Netlify, getConfig() se
  // invoca en cada request, así que solo creamos el cliente la primera vez.
  if (!clientInitialized) {
    createClient({ apiKey, region, project: PROJECT_ID } as any);
    clientInitialized = true;
  }
  return apiKey;
}

function agentIdFor(key: string) {
  const id = AGENT_IDS[key];
  if (!id) throw new Error("Agente no reconocido.");
  return id;
}

// Busca, entre los mensajes creados después de "sentAt", el más reciente que
// sea una respuesta ya terminada del agente. No dependemos de eventos del
// SDK: algunos emisores "reproducen" el historial completo al suscribirse a
// una tarea, lo que antes hacía que nos quedáramos con la respuesta del
// turno anterior en vez de esperar la nueva.
async function pollTask(session: Session) {
  const messages = await session.task.getMessages({ after: session.sentAt });
  for (const message of messages.slice().reverse()) {
    if (message.type === "agent-error") {
      session.error = message.lastError || "El agente devolvió un error.";
      session.done = true;
      return;
    }
    if (message.isAgent?.() && !message.isGenerating?.() && message.text) {
      session.message = message.text;
      session.done = true;
      return;
    }
  }
}

async function taskStatus(req: Request) {
  const body = await req.json();
  const taskId = String(body.taskId || "");
  const agentKey = String(body.agent || "");
  let session = sessions.get(taskId);
  if (!session && taskId) {
    getConfig();
    const agent = await Agent.get(agentIdFor(agentKey));
    const task = await agent.getTask(taskId);
    // No sabemos cuándo se envió el mensaje original (p. ej. la función se
    // reinició); usamos la última actualización de la tarea como referencia.
    const sentAt = new Date(task.updatedAt.getTime() - CLOCK_SKEW_BUFFER_MS);
    session = { task, agent, done: false, sentAt };
    sessions.set(taskId, session);
  }
  if (!session) return json({ error: "No se encontró la conversación; vuelve a escribir tu mensaje." }, 410);
  if (!session.done) await pollTask(session);
  if (session.error) return json({ error: session.error }, 500);
  if (!session.done) return json({ pending: true }, 202);
  return json({ taskId: session.task.id, message: session.message || "" });
}

async function start(req: Request) {
  getConfig();
  const body = await req.json();
  const agentKey = String(body.agent || "");
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) return json({ error: "Escribe un mensaje." }, 422);
  const sentAt = new Date(Date.now() - CLOCK_SKEW_BUFFER_MS);
  const agent = await Agent.get(agentIdFor(agentKey));
  const task = await agent.sendMessage(message);
  const taskId = task.id;
  const session: Session = { task, agent, done: false, sentAt };
  sessions.set(taskId, session);
  return json({ taskId, pending: true }, 202);
}

async function continueSession(req: Request) {
  const body = await req.json();
  const taskId = String(body.taskId || "");
  const agentKey = String(body.agent || "");
  const message = String(body.message || "").trim().slice(0, 2000);
  if (!message) return json({ error: "Escribe un mensaje." }, 422);
  const sentAt = new Date(Date.now() - CLOCK_SKEW_BUFFER_MS);
  let session = sessions.get(taskId);
  if (!session && taskId) {
    getConfig();
    const agent = await Agent.get(agentIdFor(agentKey));
    const task = await agent.getTask(taskId);
    session = { task, agent, done: false, sentAt };
    sessions.set(taskId, session);
  }
  if (!session) {
    // La sesión ya no vive en memoria (p. ej. la función se reinició); se
    // trata como un mensaje inicial nuevo en vez de fallar la conversación.
    getConfig();
    const agent = await Agent.get(agentIdFor(agentKey));
    const task = await agent.sendMessage(message);
    sessions.set(task.id, { task, agent, done: false, sentAt });
    return json({ taskId: task.id, pending: true }, 202);
  }
  const task = await session.agent.sendMessage(message, session.task);
  session.task = task;
  session.message = undefined;
  session.error = undefined;
  session.done = false;
  session.sentAt = sentAt;
  sessions.set(task.id, session);
  return json({ taskId: task.id, pending: true }, 202);
}

export default async (req: Request, _context: Context) => {
  try {
    if (req.method !== "POST") return json({ error: "Usa POST." }, 405);
    const url = new URL(req.url);
    if (url.pathname.endsWith("/status")) return await taskStatus(req);
    if (url.pathname.endsWith("/continue")) return await continueSession(req);
    return await start(req);
  } catch (error) {
    console.error("nova-agent", error);
    return json({ error: error instanceof Error ? error.message : "No se pudo conectar con el agente." }, 500);
  }
};

export const config: Config = {
  path: ["/api/nova", "/api/nova/status", "/api/nova/continue"],
};
