export interface TodoRecord {
  id: string;
  title: string;
  is_completed: boolean;
  created_at: string;
  updated_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);

const todoColumns = "id,title,is_completed,created_at,updated_at";

function getConfig() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return {
    url: supabaseUrl.replace(/\/+$/, ""),
    anonKey: supabaseAnonKey,
  };
}

function buildHeaders(prefer?: string): HeadersInit {
  const { anonKey } = getConfig();
  const headers: Record<string, string> = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  return headers;
}

async function throwOnError(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  let message = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as {
      message?: string;
      details?: string;
      hint?: string;
    };

    if (payload.message) {
      message = payload.message;
    }

    if (payload.details) {
      message = `${message} (${payload.details})`;
    }

    if (payload.hint) {
      message = `${message} Hint: ${payload.hint}`;
    }
  } catch {
    // Keep HTTP fallback message.
  }

  throw new Error(message);
}

export async function listTodos(): Promise<TodoRecord[]> {
  const { url } = getConfig();
  const query = new URLSearchParams({
    select: todoColumns,
    order: "created_at.desc",
  });

  const response = await fetch(`${url}/rest/v1/todos?${query.toString()}`, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });

  await throwOnError(response);
  return (await response.json()) as TodoRecord[];
}

export async function createTodo(title: string): Promise<TodoRecord> {
  const { url } = getConfig();
  const response = await fetch(`${url}/rest/v1/todos?select=${todoColumns}`, {
    method: "POST",
    headers: buildHeaders("return=representation"),
    body: JSON.stringify({ title }),
  });

  await throwOnError(response);
  const rows = (await response.json()) as TodoRecord[];
  const first = rows[0];
  if (!first) {
    throw new Error("Supabase did not return the new todo row.");
  }
  return first;
}

export async function updateTodo(
  id: string,
  updates: Partial<Pick<TodoRecord, "title" | "is_completed">>,
): Promise<TodoRecord> {
  const { url } = getConfig();
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: todoColumns,
  });

  const response = await fetch(`${url}/rest/v1/todos?${query.toString()}`, {
    method: "PATCH",
    headers: buildHeaders("return=representation"),
    body: JSON.stringify(updates),
  });

  await throwOnError(response);
  const rows = (await response.json()) as TodoRecord[];
  const first = rows[0];
  if (!first) {
    throw new Error("Todo not found.");
  }
  return first;
}

export async function deleteTodo(id: string): Promise<void> {
  const { url } = getConfig();
  const query = new URLSearchParams({ id: `eq.${id}` });
  const response = await fetch(`${url}/rest/v1/todos?${query.toString()}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });

  await throwOnError(response);
}
