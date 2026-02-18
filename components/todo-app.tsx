"use client";

import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createTodo,
  deleteTodo,
  hasSupabaseEnv,
  isPositioningEnabled,
  listTodos,
  type TodoRecord,
  updateTodo,
  updateTodoPositions,
} from "@/lib/supabase/rest";
import { cn } from "@/lib/utils";

type TodoFilter = "all" | "open" | "done";

function formatTodoDate(dateValue: string): string {
  const date = new Date(dateValue);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function arrayMove<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return items;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

function normalizePositions(items: TodoRecord[]): TodoRecord[] {
  return items.map((todo, index) => ({ ...todo, position: index }));
}

export function TodoApp() {
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [positioningAvailable, setPositioningAvailable] = useState(true);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  const latestTodosRef = useRef<TodoRecord[]>([]);

  useEffect(() => {
    latestTodosRef.current = todos;
  }, [todos]);

  const loadTodos = useCallback(async () => {
    if (!hasSupabaseEnv) {
      setIsLoading(false);
      return;
    }

    try {
      setError(null);
      const rows = await listTodos();
      setTodos(normalizePositions(rows));
      setPositioningAvailable(isPositioningEnabled());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load todos from Supabase.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const openCount = useMemo(
    () => todos.filter((todo) => !todo.is_completed).length,
    [todos],
  );
  const doneCount = todos.length - openCount;

  const filteredTodos = useMemo(() => {
    if (filter === "open") {
      return todos.filter((todo) => !todo.is_completed);
    }
    if (filter === "done") {
      return todos.filter((todo) => todo.is_completed);
    }
    return todos;
  }, [filter, todos]);

  const canReorder =
    hasSupabaseEnv &&
    filter === "all" &&
    !editingId &&
    !busyId &&
    positioningAvailable;

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasSupabaseEnv || isAdding) {
      return;
    }

    const title = newTitle.trim();
    if (!title) {
      return;
    }

    try {
      setError(null);
      setIsAdding(true);
      const position = latestTodosRef.current.length;
      const created = await createTodo(title, position);
      setTodos((previous) => normalizePositions([...previous, created]));
      setNewTitle("");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create the todo.",
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggle = async (todo: TodoRecord) => {
    if (!hasSupabaseEnv || busyId) {
      return;
    }

    try {
      setError(null);
      setBusyId(todo.id);
      const updated = await updateTodo(todo.id, {
        is_completed: !todo.is_completed,
      });
      setTodos((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Failed to update the todo.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!hasSupabaseEnv || busyId) {
      return;
    }

    try {
      setError(null);
      setBusyId(id);
      await deleteTodo(id);
      setTodos((previous) =>
        normalizePositions(previous.filter((item) => item.id !== id)),
      );
      if (editingId === id) {
        setEditingId(null);
        setEditingTitle("");
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete the todo.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (todo: TodoRecord) => {
    setEditingId(todo.id);
    setEditingTitle(todo.title);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const saveEdit = async () => {
    if (!hasSupabaseEnv || !editingId || busyId) {
      return;
    }

    const title = editingTitle.trim();
    if (!title) {
      setError("Todo title cannot be empty.");
      return;
    }

    try {
      setError(null);
      setBusyId(editingId);
      const updated = await updateTodo(editingId, { title });
      setTodos((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      cancelEdit();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update the todo title.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    activeId: string,
  ) => {
    if (!canReorder) {
      return;
    }

    event.preventDefault();
    setError(null);
    setDraggingId(activeId);

    let moved = false;
    const dragPointerId = event.pointerId;

    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== dragPointerId) {
        return;
      }

      moveEvent.preventDefault();
      const target = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-todo-id]");

      const overId = target?.dataset.todoId;
      if (!overId || overId === activeId) {
        return;
      }

      setTodos((previous) => {
        const fromIndex = previous.findIndex((todo) => todo.id === activeId);
        const toIndex = previous.findIndex((todo) => todo.id === overId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
          return previous;
        }
        moved = true;
        return normalizePositions(arrayMove(previous, fromIndex, toIndex));
      });
    };

    const cleanup = () => {
      document.body.style.userSelect = "";
      document.body.style.touchAction = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      setDraggingId(null);
    };

    const handlePointerUp = async (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== dragPointerId) {
        return;
      }

      cleanup();
      if (!moved) {
        return;
      }

      if (!positioningAvailable) {
        return;
      }

      try {
        setIsSavingOrder(true);
        await updateTodoPositions(latestTodosRef.current.map((todo) => todo.id));
      } catch (saveOrderError) {
        setError(
          saveOrderError instanceof Error
            ? saveOrderError.message
            : "Failed to persist task order.",
        );
      } finally {
        setIsSavingOrder(false);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const emptyStateLabel =
    filter === "all"
      ? "No tasks yet. Add your first one."
      : filter === "open"
        ? "No open tasks right now."
        : "No completed tasks yet.";

  return (
    <main className="safe-area-shell">
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardHeader className="pb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">
                Nest
              </p>
              <Badge variant="secondary">{openCount} open</Badge>
            </div>
            <CardTitle className="text-3xl leading-tight">Your reminders</CardTitle>
            <CardDescription>
              Minimal by design. Add, complete, edit, delete, and drag to reorder.
            </CardDescription>
            <div className="mt-2 flex gap-2 text-xs text-muted-foreground">
              <span>{todos.length} total</span>
              <span>/</span>
              <span>{doneCount} done</span>
              {isSavingOrder && (
                <>
                  <span>/</span>
                  <span>Saving order...</span>
                </>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasSupabaseEnv && (
              <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
                Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to start syncing.
              </div>
            )}

            {!positioningAvailable && hasSupabaseEnv && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                Drag reorder requires a <code>position</code> column. Run the updated
                SQL in <code>supabase/schema.sql</code> and refresh.
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground">
                {error}
              </div>
            )}

            <form className="flex items-center gap-2" onSubmit={handleAdd}>
              <Input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="Add a task for today"
                maxLength={120}
                disabled={!hasSupabaseEnv || isAdding}
              />
              <Button type="submit" disabled={!hasSupabaseEnv || isAdding}>
                {isAdding ? "Adding" : "Add"}
              </Button>
            </form>

            <div className="flex flex-wrap gap-2">
              <Button
                variant={filter === "all" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFilter("all")}
              >
                All
              </Button>
              <Button
                variant={filter === "open" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFilter("open")}
              >
                Open
              </Button>
              <Button
                variant={filter === "done" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFilter("done")}
              >
                Done
              </Button>
            </div>

            {filter !== "all" && (
              <p className="text-xs text-muted-foreground">
                Switch to <strong>All</strong> to drag and reorder tasks.
              </p>
            )}

            <div className="space-y-2">
              {isLoading && (
                <div className="rounded-lg border border-border/80 bg-muted/50 p-4 text-sm text-muted-foreground">
                  Loading tasks...
                </div>
              )}

              {!isLoading && filteredTodos.length === 0 && (
                <div className="rounded-lg border border-border/80 bg-muted/40 p-4 text-sm text-muted-foreground">
                  {emptyStateLabel}
                </div>
              )}

              {!isLoading &&
                filteredTodos.map((todo) => {
                  const isBusy = busyId === todo.id;
                  const isEditing = editingId === todo.id;
                  const isDragging = draggingId === todo.id;

                  return (
                    <article
                      key={todo.id}
                      data-todo-id={todo.id}
                      className={cn(
                        "rounded-xl border border-border/80 bg-background/40 p-3 transition",
                        todo.is_completed && "opacity-70",
                        isDragging && "scale-[1.01] border-primary/50 shadow-lg",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          aria-label={
                            todo.is_completed
                              ? "Mark task as not completed"
                              : "Mark task as completed"
                          }
                          className={cn(
                            "mt-1 h-5 w-5 rounded-full border transition",
                            todo.is_completed
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/60 bg-transparent hover:border-primary",
                          )}
                          onClick={() => void handleToggle(todo)}
                          disabled={!hasSupabaseEnv || isBusy}
                        />

                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <Input
                              value={editingTitle}
                              onChange={(event) =>
                                setEditingTitle(event.target.value)
                              }
                              maxLength={120}
                              disabled={isBusy}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void saveEdit();
                                }
                                if (event.key === "Escape") {
                                  cancelEdit();
                                }
                              }}
                            />
                          ) : (
                            <p
                              className={cn(
                                "break-words text-sm leading-relaxed",
                                todo.is_completed &&
                                  "text-muted-foreground line-through",
                              )}
                            >
                              {todo.title}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatTodoDate(todo.created_at)}
                          </p>
                        </div>

                        <button
                          type="button"
                          onPointerDown={(event) => startDrag(event, todo.id)}
                          disabled={!canReorder || isEditing || isBusy}
                          aria-label="Drag to reorder"
                          className="mt-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted disabled:opacity-40"
                        >
                          Drag
                        </button>
                      </div>

                      <div className="mt-3 flex items-center justify-end gap-2">
                        {isEditing ? (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void saveEdit()}
                              disabled={!hasSupabaseEnv || isBusy}
                            >
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={cancelEdit}
                              disabled={isBusy}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(todo)}
                              disabled={!hasSupabaseEnv || isBusy}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => void handleDelete(todo.id)}
                              disabled={!hasSupabaseEnv || isBusy}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
