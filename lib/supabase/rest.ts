export interface TodoRecord {
  id: string;
  title: string;
  is_completed: boolean;
  position: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);

const baseColumns = "id,title,is_completed,created_at,updated_at";
const parentColumns = `${baseColumns},parent_id`;
const positionedColumns = `${parentColumns},position`;
const positionedNoParentColumns = `${baseColumns},position`;
let supportsPositionColumn: boolean | null = null;
let supportsParentColumn: boolean | null = null;

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

  const withPositionQuery = new URLSearchParams({ select: positionedColumns });
  withPositionQuery.append("order", "position.asc.nullslast");
  withPositionQuery.append("order", "created_at.asc");

  const withPositionResponse = await fetch(
    `${url}/rest/v1/todos?${withPositionQuery.toString()}`,
    {
      method: "GET",
      headers: buildHeaders(),
      cache: "no-store",
    },
  );

  if (withPositionResponse.ok) {
    supportsPositionColumn = true;
    supportsParentColumn = true;
    const rows = (await withPositionResponse.json()) as TodoRecord[];
    return rows.map((row, index) => ({ ...row, position: row.position ?? index }));
  }

  let fallbackReason = "Failed to load todos from Supabase.";
  try {
    const payload = (await withPositionResponse.json()) as { message?: string };
    fallbackReason = payload.message ?? fallbackReason;
  } catch {
    // Keep fallback reason.
  }

  const isMissingParentColumn =
    fallbackReason.toLowerCase().includes("parent_id") &&
    (fallbackReason.toLowerCase().includes("column") ||
      fallbackReason.toLowerCase().includes("does not exist"));

  if (isMissingParentColumn) {
    const withoutParentQuery = new URLSearchParams({
      select: positionedNoParentColumns,
    });
    withoutParentQuery.append("order", "position.asc.nullslast");
    withoutParentQuery.append("order", "created_at.asc");
    const withoutParentResponse = await fetch(
      `${url}/rest/v1/todos?${withoutParentQuery.toString()}`,
      {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
      },
    );

    await throwOnError(withoutParentResponse);
    supportsPositionColumn = true;
    supportsParentColumn = false;
    const rows = (await withoutParentResponse.json()) as Array<
      Omit<TodoRecord, "parent_id">
    >;
    return rows.map((row, index) => ({
      ...row,
      parent_id: null,
      position: row.position ?? index,
    }));
  }

  const missingPositionColumn =
    fallbackReason.toLowerCase().includes("position") &&
    (fallbackReason.toLowerCase().includes("column") ||
      fallbackReason.toLowerCase().includes("does not exist"));

  if (!missingPositionColumn) {
    throw new Error(fallbackReason);
  }

  const fallbackQuery = new URLSearchParams({
    select: baseColumns,
    order: "created_at.asc",
  });
  const fallbackResponse = await fetch(
    `${url}/rest/v1/todos?${fallbackQuery.toString()}`,
    {
      method: "GET",
      headers: buildHeaders(),
      cache: "no-store",
    },
  );

  await throwOnError(fallbackResponse);
  supportsPositionColumn = false;
  supportsParentColumn = false;
  const fallbackRows = (await fallbackResponse.json()) as Array<
    Omit<TodoRecord, "position" | "parent_id">
  >;
  return fallbackRows.map((row, index) => ({
    ...row,
    parent_id: null,
    position: index,
  }));
}

function currentSelectColumns() {
  if (supportsPositionColumn === false) {
    return supportsParentColumn === false ? baseColumns : parentColumns;
  }
  return supportsParentColumn === false
    ? positionedNoParentColumns
    : positionedColumns;
}

function normalizeTodoFromApi(
  row: Partial<TodoRecord>,
  fallbackPosition: number,
): TodoRecord {
  return {
    id: row.id ?? "",
    title: row.title ?? "",
    is_completed: Boolean(row.is_completed),
    position:
      typeof row.position === "number" ? row.position : Math.max(0, fallbackPosition),
    parent_id: row.parent_id ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
}

export function isPositioningEnabled(): boolean {
  return supportsPositionColumn !== false;
}

export async function createTodo(
  title: string,
  position: number,
): Promise<TodoRecord> {
  const { url } = getConfig();
  const body =
    supportsPositionColumn === false ? { title } : { title, position };
  const response = await fetch(
    `${url}/rest/v1/todos?select=${currentSelectColumns()}`,
    {
      method: "POST",
      headers: buildHeaders("return=representation"),
      body: JSON.stringify(body),
    },
  );

  await throwOnError(response);
  const rows = (await response.json()) as Array<Partial<TodoRecord>>;
  const first = rows[0];
  if (!first) {
    throw new Error("Supabase did not return the new todo row.");
  }
  return normalizeTodoFromApi(first, position);
}

export async function updateTodo(
  id: string,
  updates: Partial<
    Pick<TodoRecord, "title" | "is_completed" | "position" | "parent_id">
  >,
): Promise<TodoRecord> {
  const { url } = getConfig();
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: currentSelectColumns(),
  });

  const response = await fetch(`${url}/rest/v1/todos?${query.toString()}`, {
    method: "PATCH",
    headers: buildHeaders("return=representation"),
    body: JSON.stringify(updates),
  });

  await throwOnError(response);
  const rows = (await response.json()) as Array<Partial<TodoRecord>>;
  const first = rows[0];
  if (!first) {
    throw new Error("Todo not found.");
  }
  return normalizeTodoFromApi(first, updates.position ?? 0);
}

export async function updateTodoPositions(
  orderedIds: string[],
): Promise<void> {
  if (supportsPositionColumn === false) {
    return;
  }

  const { url } = getConfig();
  await Promise.all(
    orderedIds.map(async (id, index) => {
      const query = new URLSearchParams({ id: `eq.${id}` });
      const response = await fetch(`${url}/rest/v1/todos?${query.toString()}`, {
        method: "PATCH",
        headers: buildHeaders("return=minimal"),
        body: JSON.stringify({ position: index }),
      });

      await throwOnError(response);
    }),
  );
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
