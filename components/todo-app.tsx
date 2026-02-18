"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GripVertical, Pencil, Trash2 } from "lucide-react";

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
type ControlRole = "toggle" | "drag" | "edit" | "delete" | "filter";
const filterOrder: TodoFilter[] = ["all", "open", "done"];

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
  const [keyboardDragId, setKeyboardDragId] = useState<string | null>(null);
  const [positioningAvailable, setPositioningAvailable] = useState(true);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  const latestTodosRef = useRef<TodoRecord[]>([]);
  const keyboardMovedRef = useRef(false);
  const filterButtonRefs = useRef<Record<TodoFilter, HTMLButtonElement | null>>({
    all: null,
    open: null,
    done: null,
  });
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstTodoToggleRef = useRef<HTMLButtonElement | null>(null);
  const editingInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const returnEditFocusIdRef = useRef<string | null>(null);
  const todoControlRefs = useRef<
    Record<string, Record<Exclude<ControlRole, "filter">, HTMLButtonElement | null>>
  >({});

  useEffect(() => {
    latestTodosRef.current = todos;
  }, [todos]);

  useEffect(() => {
    if (!editingId) {
      const returnId = returnEditFocusIdRef.current;
      if (returnId) {
        todoControlRefs.current[returnId]?.edit?.focus();
        returnEditFocusIdRef.current = null;
      }
      return;
    }

    editingInputRefs.current[editingId]?.focus();
  }, [editingId]);

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
  const firstVisibleTodoId = filteredTodos[0]?.id ?? null;
  const visibleTodoIds = filteredTodos.map((todo) => todo.id);

  const persistCurrentOrder = useCallback(async () => {
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
  }, [positioningAvailable]);

  const moveTodoByOffset = useCallback((activeId: string, offset: number) => {
    let moved = false;
    setTodos((previous) => {
      const fromIndex = previous.findIndex((todo) => todo.id === activeId);
      if (fromIndex === -1) {
        return previous;
      }

      const toIndex = fromIndex + offset;
      if (toIndex < 0 || toIndex >= previous.length) {
        return previous;
      }

      moved = true;
      return normalizePositions(arrayMove(previous, fromIndex, toIndex));
    });
    return moved;
  }, []);

  const setTodoControlRef = useCallback(
    (
      todoId: string,
      role: Exclude<ControlRole, "filter">,
      element: HTMLButtonElement | null,
    ) => {
      if (!todoControlRefs.current[todoId]) {
        todoControlRefs.current[todoId] = {
          toggle: null,
          drag: null,
          edit: null,
          delete: null,
        };
      }
      todoControlRefs.current[todoId][role] = element;
    },
    [],
  );

  const focusTodoControlByIndex = useCallback(
    (index: number, role: Exclude<ControlRole, "filter">): boolean => {
      const targetId = visibleTodoIds[index];
      if (!targetId) {
        return false;
      }
      const target = todoControlRefs.current[targetId]?.[role];
      if (!target || target.disabled) {
        return false;
      }
      target.focus();
      return true;
    },
    [visibleTodoIds],
  );

  const focusByTabOrder = useCallback(
    (currentElement: HTMLElement, direction: "forward" | "backward"): boolean => {
      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>('[data-nav-managed="true"]'),
      ).filter((element) => !element.hasAttribute("disabled"));

      const currentIndex = focusables.indexOf(currentElement);
      if (currentIndex === -1) {
        return false;
      }

      const targetIndex =
        direction === "forward" ? currentIndex + 1 : currentIndex - 1;
      const next = focusables[targetIndex];
      if (!next) {
        return false;
      }
      next.focus();
      return true;
    },
    [],
  );

  const handleAddInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      filterButtonRefs.current.all?.focus();
      return;
    }

    if (
      event.key === "ArrowRight" &&
      event.currentTarget.selectionStart === event.currentTarget.value.length &&
      event.currentTarget.selectionEnd === event.currentTarget.value.length
    ) {
      event.preventDefault();
      addButtonRef.current?.focus();
      return;
    }

    if (
      event.key === "ArrowLeft" &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      const moved = focusByTabOrder(event.currentTarget, "backward");
      if (moved) {
        event.preventDefault();
      }
    }
  };

  const handleAddButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      addInputRef.current?.focus();
      return;
    }

    if (event.key === "ArrowRight") {
      const moved = focusByTabOrder(event.currentTarget, "forward");
      if (moved) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      filterButtonRefs.current.all?.focus();
    }
  };

  const handleFilterKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentFilter: TodoFilter,
  ) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const currentIndex = filterOrder.indexOf(currentFilter);
      const atStart = currentIndex === 0;
      const atEnd = currentIndex === filterOrder.length - 1;

      if (event.key === "ArrowLeft" && atStart) {
        const moved = focusByTabOrder(event.currentTarget, "backward");
        if (moved) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "ArrowRight" && atEnd) {
        const moved = focusByTabOrder(event.currentTarget, "forward");
        if (moved) {
          event.preventDefault();
        }
        return;
      }

      event.preventDefault();
      const nextIndex = event.key === "ArrowRight" ? currentIndex + 1 : currentIndex - 1;
      filterButtonRefs.current[filterOrder[nextIndex]]?.focus();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      firstTodoToggleRef.current?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      addInputRef.current?.focus();
    }
  };

  const handleTodoControlNavigation = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    todoIndex: number,
    role: Exclude<ControlRole, "filter">,
    todoId: string,
  ) => {
    const key = event.key;
    let moved = false;
    const isCurrentEditing = editingId === todoId;

    if (key === "ArrowLeft") {
      if (role === "toggle") {
        moved = focusByTabOrder(event.currentTarget, "backward");
      } else if (role === "drag") {
        if (isCurrentEditing) {
          editingInputRefs.current[todoId]?.focus();
          moved = true;
        } else {
          moved = focusTodoControlByIndex(todoIndex, "toggle");
        }
      } else if (role === "edit") {
        moved = focusByTabOrder(event.currentTarget, "backward");
      } else if (role === "delete") {
        moved = focusTodoControlByIndex(todoIndex, "edit");
      }
    }

    if (key === "ArrowRight") {
      if (role === "toggle") {
        if (isCurrentEditing) {
          editingInputRefs.current[todoId]?.focus();
          moved = true;
        } else {
          moved = focusTodoControlByIndex(todoIndex, "drag");
        }
      } else if (role === "drag") {
        moved = focusByTabOrder(event.currentTarget, "forward");
      } else if (role === "edit") {
        moved = focusTodoControlByIndex(todoIndex, "delete");
      } else if (role === "delete") {
        moved = focusByTabOrder(event.currentTarget, "forward");
      }
    }

    if (key === "ArrowUp") {
      if (role === "toggle" || role === "drag") {
        if (todoIndex === 0) {
          filterButtonRefs.current.all?.focus();
          moved = true;
        } else {
          moved = focusTodoControlByIndex(todoIndex - 1, "edit");
        }
      } else if (role === "edit" || role === "delete") {
        moved = focusTodoControlByIndex(todoIndex, "toggle");
      }
    }

    if (key === "ArrowDown") {
      if (role === "toggle") {
        moved = focusTodoControlByIndex(todoIndex, "edit");
      } else if (role === "drag") {
        moved = focusTodoControlByIndex(todoIndex, "delete");
      } else if (role === "edit" || role === "delete") {
        moved = focusTodoControlByIndex(todoIndex + 1, "toggle");
      }
    }

    if (moved) {
      event.preventDefault();
    }
  };

  const handleEditingInputKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    todoIndex: number,
    todoId: string,
  ) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      todoControlRefs.current[todoId]?.toggle?.focus();
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      todoControlRefs.current[todoId]?.drag?.focus();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (todoIndex === 0) {
        filterButtonRefs.current.all?.focus();
      } else {
        focusTodoControlByIndex(todoIndex - 1, "edit");
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusTodoControlByIndex(todoIndex + 1, "toggle");
    }
  };

  useEffect(() => {
    const handleWindowArrowFocus = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight"
      ) {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const isManaged =
        active?.dataset.navManaged === "true" ||
        active?.tagName.toLowerCase() === "input";

      if (isManaged) {
        return;
      }

      event.preventDefault();
      addInputRef.current?.focus();
    };

    window.addEventListener("keydown", handleWindowArrowFocus);
    return () => {
      window.removeEventListener("keydown", handleWindowArrowFocus);
    };
  }, []);

  const deactivateKeyboardDrag = useCallback(
    (shouldPersistOrder: boolean) => {
      const movedDuringSession = keyboardMovedRef.current;
      keyboardMovedRef.current = false;
      setKeyboardDragId(null);
      setDraggingId(null);

      if (shouldPersistOrder && movedDuringSession) {
        void persistCurrentOrder();
      }
    },
    [persistCurrentOrder],
  );

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
        returnEditFocusIdRef.current = id;
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
    if (editingId) {
      returnEditFocusIdRef.current = editingId;
    }
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
      returnEditFocusIdRef.current = editingId;
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
    if (keyboardDragId) {
      return;
    }

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

      await persistCurrentOrder();
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleDragHandleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    todoId: string,
    todoIndex: number,
  ) => {
    const isActiveKeyboardDrag = keyboardDragId === todoId;

    if ((event.key === "Enter" || event.key === " ") && !canReorder) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isActiveKeyboardDrag) {
        deactivateKeyboardDrag(true);
      } else {
        keyboardMovedRef.current = false;
        setError(null);
        setKeyboardDragId(todoId);
        setDraggingId(todoId);
      }
      return;
    }

    if (!isActiveKeyboardDrag) {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight"
      ) {
        handleTodoControlNavigation(event, todoIndex, "drag", todoId);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const moved = moveTodoByOffset(todoId, -1);
      if (moved) {
        keyboardMovedRef.current = true;
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const moved = moveTodoByOffset(todoId, 1);
      if (moved) {
        keyboardMovedRef.current = true;
      }
      return;
    }

    if (event.key === "Tab") {
      deactivateKeyboardDrag(true);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      deactivateKeyboardDrag(false);
    }
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
                ref={addInputRef}
                data-nav-managed="true"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                onKeyDown={handleAddInputKeyDown}
                placeholder="Add a task for today"
                maxLength={120}
                disabled={!hasSupabaseEnv || isAdding}
              />
              <Button
                ref={addButtonRef}
                data-nav-managed="true"
                type="submit"
                onKeyDown={handleAddButtonKeyDown}
                disabled={!hasSupabaseEnv || isAdding}
              >
                {isAdding ? "Adding" : "Add"}
              </Button>
            </form>

            <div className="flex flex-wrap gap-2">
              <Button
                variant={filter === "all" ? "secondary" : "ghost"}
                size="sm"
                data-control-role="filter"
                data-nav-managed="true"
                ref={(element) => {
                  filterButtonRefs.current.all = element;
                }}
                onKeyDown={(event) => handleFilterKeyDown(event, "all")}
                onClick={() => setFilter("all")}
              >
                All
              </Button>
              <Button
                variant={filter === "open" ? "secondary" : "ghost"}
                size="sm"
                data-control-role="filter"
                data-nav-managed="true"
                ref={(element) => {
                  filterButtonRefs.current.open = element;
                }}
                onKeyDown={(event) => handleFilterKeyDown(event, "open")}
                onClick={() => setFilter("open")}
              >
                Open
              </Button>
              <Button
                variant={filter === "done" ? "secondary" : "ghost"}
                size="sm"
                data-control-role="filter"
                data-nav-managed="true"
                ref={(element) => {
                  filterButtonRefs.current.done = element;
                }}
                onKeyDown={(event) => handleFilterKeyDown(event, "done")}
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
            {filter === "all" && positioningAvailable && (
              <p className="text-xs text-muted-foreground">
                Tab to a drag icon, press Enter or Space to grab, use Up/Down
                arrows, then Enter or Tab to drop.
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
                filteredTodos.map((todo, todoIndex) => {
                  const isBusy = busyId === todo.id;
                  const isEditing = editingId === todo.id;
                  const isDragging =
                    draggingId === todo.id || keyboardDragId === todo.id;

                  return (
                    <article
                      key={todo.id}
                      data-todo-id={todo.id}
                      className={cn(
                        "rounded-xl border border-border/80 bg-background/40 p-3 transition",
                        todo.is_completed && "opacity-70",
                        isDragging && "scale-[1.01] border-primary/50 shadow-lg",
                      )}
                      style={
                        isDragging
                          ? { outline: "auto", outlineOffset: "2px" }
                          : undefined
                      }
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          aria-label={
                            todo.is_completed
                              ? "Mark task as not completed"
                              : "Mark task as completed"
                          }
                          data-control-role="toggle"
                          data-nav-managed="true"
                          className={cn(
                            "mt-1 h-5 w-5 rounded-full border transition",
                            todo.is_completed
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/60 bg-transparent hover:border-primary",
                          )}
                          onKeyDown={(event) =>
                            handleTodoControlNavigation(
                              event,
                              todoIndex,
                              "toggle",
                              todo.id,
                            )
                          }
                          ref={(element) => {
                            if (todo.id === firstVisibleTodoId) {
                              firstTodoToggleRef.current = element;
                            }
                            setTodoControlRef(todo.id, "toggle", element);
                          }}
                          onClick={() => void handleToggle(todo)}
                          disabled={!hasSupabaseEnv}
                        />

                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <Input
                              ref={(element) => {
                                editingInputRefs.current[todo.id] = element;
                              }}
                              data-nav-managed="true"
                              value={editingTitle}
                              onChange={(event) =>
                                setEditingTitle(event.target.value)
                              }
                              maxLength={120}
                              disabled={isBusy}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "ArrowLeft" ||
                                  event.key === "ArrowRight" ||
                                  event.key === "ArrowUp" ||
                                  event.key === "ArrowDown"
                                ) {
                                  handleEditingInputKeyDown(event, todoIndex, todo.id);
                                  return;
                                }
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
                          data-control-role="drag"
                          data-nav-managed="true"
                          onPointerDown={(event) => startDrag(event, todo.id)}
                          onKeyDown={(event) =>
                            handleDragHandleKeyDown(event, todo.id, todoIndex)
                          }
                          disabled={
                            !canReorder ||
                            isEditing ||
                            isBusy ||
                            (keyboardDragId !== null && keyboardDragId !== todo.id)
                          }
                          aria-label={
                            keyboardDragId === todo.id
                              ? "Dragging. Use up and down arrows to move. Press Enter or Tab to drop."
                              : "Drag to reorder"
                          }
                          aria-pressed={keyboardDragId === todo.id}
                          ref={(element) => setTodoControlRef(todo.id, "drag", element)}
                          className="mt-1 inline-flex touch-none items-center rounded p-1 text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                        >
                          <GripVertical className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mt-3 flex items-center justify-start gap-2">
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
                              data-control-role="edit"
                              data-nav-managed="true"
                              onKeyDown={(event) =>
                                handleTodoControlNavigation(
                                  event,
                                  todoIndex,
                                  "edit",
                                  todo.id,
                                )
                              }
                              onClick={() => startEdit(todo)}
                              disabled={!hasSupabaseEnv || isBusy}
                              aria-label="Edit task"
                              title="Edit"
                              ref={(element) => setTodoControlRef(todo.id, "edit", element)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              data-control-role="delete"
                              data-nav-managed="true"
                              onKeyDown={(event) =>
                                handleTodoControlNavigation(
                                  event,
                                  todoIndex,
                                  "delete",
                                  todo.id,
                                )
                              }
                              onClick={() => void handleDelete(todo.id)}
                              disabled={!hasSupabaseEnv || isBusy}
                              aria-label="Delete task"
                              title="Delete"
                              className="text-muted-foreground hover:text-foreground"
                              ref={(element) =>
                                setTodoControlRef(todo.id, "delete", element)
                              }
                            >
                              <Trash2 className="h-4 w-4" />
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
