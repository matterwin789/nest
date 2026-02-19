"use client";

import {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { MoreHorizontal } from "lucide-react";
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

const CARD_HOLD_TO_DRAG_MS = 180;
const CARD_MOVE_CANCEL_PX = 6;
const CARD_HORIZONTAL_NEST_PX = 36;

function compactAndMoveSelection(
  items: TodoRecord[],
  selectedIds: string[],
  activeId: string,
  offset: -1 | 1,
): { next: TodoRecord[]; changed: boolean } {
  const selectedSet = new Set(selectedIds);
  const orderedSelected = items.filter((todo) => selectedSet.has(todo.id));
  const block = orderedSelected.length
    ? orderedSelected
    : items.filter((todo) => todo.id === activeId);
  if (!block.length) {
    return { next: items, changed: false };
  }

  const anchorIndex = items.findIndex((todo) => todo.id === block[0]?.id);
  if (anchorIndex === -1) {
    return { next: items, changed: false };
  }

  const blockSet = new Set(block.map((todo) => todo.id));
  const stationary = items.filter((todo) => !blockSet.has(todo.id));
  const compacted = [...stationary];
  compacted.splice(anchorIndex, 0, ...block);

  const canMoveUp = offset < 0 && anchorIndex > 0;
  const canMoveDown = offset > 0 && anchorIndex + block.length < compacted.length;

  if (!canMoveUp && !canMoveDown) {
    const changed = compacted.some((todo, index) => todo.id !== items[index]?.id);
    return { next: changed ? normalizePositions(compacted) : items, changed };
  }

  const withoutBlock = compacted.filter((todo) => !blockSet.has(todo.id));
  const nextStart = anchorIndex + offset;
  const moved = [...withoutBlock];
  moved.splice(nextStart, 0, ...block);

  const changed = moved.some((todo, index) => todo.id !== items[index]?.id);
  return { next: changed ? normalizePositions(moved) : items, changed };
}

function compactSelectionAtAnchor(
  items: TodoRecord[],
  selectedIds: string[],
  activeId: string,
): { compacted: TodoRecord[]; block: TodoRecord[]; anchorIndex: number } | null {
  const selectedSet = new Set(selectedIds);
  const orderedSelected = items.filter((todo) => selectedSet.has(todo.id));
  const block = orderedSelected.length
    ? orderedSelected
    : items.filter((todo) => todo.id === activeId);
  if (!block.length) {
    return null;
  }

  const anchorIndex = items.findIndex((todo) => todo.id === block[0]?.id);
  if (anchorIndex === -1) {
    return null;
  }

  const blockSet = new Set(block.map((todo) => todo.id));
  const stationary = items.filter((todo) => !blockSet.has(todo.id));
  const compacted = [...stationary];
  compacted.splice(anchorIndex, 0, ...block);
  return { compacted, block, anchorIndex };
}

function normalizeMovedParentsAfterReorder(
  items: TodoRecord[],
  movedIds: string[],
): { next: TodoRecord[]; parentUpdates: Array<{ id: string; parent_id: string | null }> } {
  const next = items.map((todo) => ({ ...todo }));
  const byId = new Map(next.map((todo) => [todo.id, todo]));
  const indexById = new Map(next.map((todo, index) => [todo.id, index]));
  const parentUpdates: Array<{ id: string; parent_id: string | null }> = [];

  for (const movedId of movedIds) {
    const todo = byId.get(movedId);
    if (!todo) {
      continue;
    }

    let changed = false;
    while (todo.parent_id) {
      const parent = byId.get(todo.parent_id);
      if (!parent) {
        todo.parent_id = null;
        changed = true;
        break;
      }

      const parentIndex = indexById.get(parent.id) ?? -1;
      const todoIndex = indexById.get(todo.id) ?? -1;
      if (parentIndex !== -1 && parentIndex < todoIndex) {
        break;
      }

      todo.parent_id = parent.parent_id ?? null;
      changed = true;
    }

    if (changed) {
      parentUpdates.push({ id: todo.id, parent_id: todo.parent_id ?? null });
    }
  }

  return { next, parentUpdates };
}

export function TodoApp() {
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isAddCardActive, setIsAddCardActive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [showCompleted, setShowCompleted] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragHorizontalIntent, setDragHorizontalIntent] = useState<
    "nest" | "unnest" | null
  >(null);
  const [selectedTodoIds, setSelectedTodoIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [positioningAvailable, setPositioningAvailable] = useState(true);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  const latestTodosRef = useRef<TodoRecord[]>([]);
  const completedToggleRef = useRef<HTMLButtonElement | null>(null);
  const addCardRowRef = useRef<HTMLElement | null>(null);
  const todoCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const todoDoneRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const todoTextRefs = useRef<Record<string, HTMLElement | null>>({});
  const todoMenuRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const addCardFieldRef = useRef<HTMLDivElement | null>(null);
  const skipNextAddBlurSaveRef = useRef(false);
  const editingFieldRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const editingSeedTextRef = useRef("");
  const skipNextEditBlurSaveRef = useRef(false);
  const doneCount = useMemo(
    () => todos.filter((todo) => todo.is_completed).length,
    [todos],
  );
  const filteredTodos = useMemo(
    () => (showCompleted ? todos : todos.filter((todo) => !todo.is_completed)),
    [showCompleted, todos],
  );
  const depthByTodoId = useMemo(() => {
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    const memo = new Map<string, number>();

    const depthFor = (todoId: string): number => {
      if (memo.has(todoId)) {
        return memo.get(todoId) ?? 0;
      }

      const seen = new Set<string>();
      let depth = 0;
      let current = byId.get(todoId);
      while (current?.parent_id && byId.has(current.parent_id)) {
        if (seen.has(current.parent_id)) {
          break;
        }
        seen.add(current.parent_id);
        depth += 1;
        current = byId.get(current.parent_id);
      }
      // If the row has a parent_id but ancestor isn't in the current map,
      // still render one guide level so nesting remains visible.
      if (depth === 0 && byId.get(todoId)?.parent_id) {
        depth = 1;
      }
      const boundedDepth = Math.min(depth, 8);
      memo.set(todoId, boundedDepth);
      return boundedDepth;
    };

    const result: Record<string, number> = {};
    todos.forEach((todo) => {
      result[todo.id] = depthFor(todo.id);
    });
    return result;
  }, [todos]);
  const selectedTodoIdSet = useMemo(
    () => new Set(selectedTodoIds),
    [selectedTodoIds],
  );

  const focusAddCardField = useCallback(() => {
    const field = addCardFieldRef.current;
    if (!field) {
      return;
    }

    field.focus();
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const focusAddCardRow = useCallback(() => {
    addCardRowRef.current?.focus();
  }, []);

  const activateAddCardEditor = useCallback(() => {
    setIsAddCardActive(true);
    requestAnimationFrame(() => {
      focusAddCardField();
    });
  }, [focusAddCardField]);

  const moveArrowFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return false;
      }

      const target = event.target as HTMLElement;
      if (target.isContentEditable) {
        return false;
      }

      const rail: HTMLElement[] = [
        completedToggleRef.current,
        addCardRowRef.current,
        ...filteredTodos
          .map((todo) => todoCardRefs.current[todo.id])
          .filter((element): element is HTMLElement => Boolean(element)),
      ].filter((element): element is HTMLElement => Boolean(element));

      const current = event.currentTarget as HTMLElement;
      const index = rail.indexOf(current);
      if (index === -1) {
        return false;
      }

      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(rail.length - 1, index + delta));
      if (nextIndex === index) {
        return true;
      }

      event.preventDefault();
      rail[nextIndex]?.focus();
      return true;
    },
    [filteredTodos],
  );

  const moveHorizontalFocusInCard = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, todoId: string) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return false;
      }

      const target = event.target as HTMLElement;
      if (target.isContentEditable) {
        return false;
      }

      const card = todoCardRefs.current[todoId];
      const leftToRight: HTMLElement[] = [
        todoDoneRefs.current[todoId],
        todoTextRefs.current[todoId],
        todoMenuRefs.current[todoId],
      ].filter((element): element is HTMLElement => Boolean(element));

      if (!card || leftToRight.length === 0) {
        return false;
      }

      const order =
        event.key === "ArrowLeft"
          ? [...leftToRight].reverse().concat(card)
          : leftToRight.concat(card);

      const current = event.currentTarget as HTMLElement;
      const index = order.indexOf(current);
      const nextIndex = index === -1 ? 0 : (index + 1) % order.length;

      event.preventDefault();
      order[nextIndex]?.focus();
      return true;
    },
    [],
  );

  const moveShiftSelectionByOffset = useCallback(
    (focusedTodoId: string, offset: number) => {
      const focusedIndex = filteredTodos.findIndex(
        (todo) => todo.id === focusedTodoId,
      );
      if (focusedIndex === -1) {
        return false;
      }

      const nextIndex = focusedIndex + offset;
      if (nextIndex < 0 || nextIndex >= filteredTodos.length) {
        return true;
      }

      const anchorId = selectionAnchorId ?? focusedTodoId;
      const anchorIndex = filteredTodos.findIndex((todo) => todo.id === anchorId);
      if (anchorIndex === -1) {
        return false;
      }

      const [start, end] =
        anchorIndex <= nextIndex
          ? [anchorIndex, nextIndex]
          : [nextIndex, anchorIndex];
      const rangeIds = filteredTodos.slice(start, end + 1).map((todo) => todo.id);
      setSelectionAnchorId(anchorId);
      setSelectedTodoIds(rangeIds);

      const nextTodoId = filteredTodos[nextIndex]?.id;
      if (nextTodoId) {
        todoCardRefs.current[nextTodoId]?.focus();
      }
      return true;
    },
    [filteredTodos, selectionAnchorId],
  );

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      const isNavKey =
        key === "Tab" ||
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight";
      const isEnter = key === "Enter";

      if (!isNavKey && !isEnter) {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const noFocusedControl =
        !active || active === document.body || active === document.documentElement;

      if (!noFocusedControl) {
        return;
      }

      if (isEnter) {
        event.preventDefault();
        activateAddCardEditor();
        return;
      }

      event.preventDefault();
      focusAddCardRow();
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [activateAddCardEditor, focusAddCardRow]);

  useEffect(() => {
    latestTodosRef.current = todos;
  }, [todos]);

  useEffect(() => {
    const visibleIds = new Set(filteredTodos.map((todo) => todo.id));
    setSelectedTodoIds((previous) => previous.filter((id) => visibleIds.has(id)));
    if (selectionAnchorId && !visibleIds.has(selectionAnchorId)) {
      setSelectionAnchorId(null);
    }
  }, [filteredTodos, selectionAnchorId]);

  useEffect(() => {
    if (!editingId) {
      return;
    }

    const field = editingFieldRefs.current[editingId];
    if (!field) {
      return;
    }

    if (field.textContent !== editingSeedTextRef.current) {
      field.textContent = editingSeedTextRef.current;
    }

    field.focus();
    const range = document.createRange();
    range.selectNodeContents(field);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editingId]);

  useEffect(() => {
    if (!isAddCardActive) {
      return;
    }

    const field = addCardFieldRef.current;
    if (!field) {
      return;
    }

    if (field.textContent !== newTitle) {
      field.textContent = newTitle;
    }

    focusAddCardField();
  }, [focusAddCardField, isAddCardActive, newTitle]);

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

  const canReorder =
    hasSupabaseEnv &&
    showCompleted &&
    !editingId &&
    !busyId &&
    positioningAvailable;

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

  const moveFocusedSelectionByOffset = useCallback(
    async (activeId: string, offset: -1 | 1) => {
      if (!canReorder) {
        return;
      }

      const selectedForAction =
        selectedTodoIds.length > 0 && selectedTodoIds.includes(activeId)
          ? selectedTodoIds
          : [];
      const movedIds = selectedForAction.length > 0 ? selectedForAction : [activeId];

      const snapshot = latestTodosRef.current;
      const moved = compactAndMoveSelection(
        snapshot,
        selectedForAction,
        activeId,
        offset,
      );
      if (!moved.changed) {
        return;
      }

      const normalized = normalizeMovedParentsAfterReorder(moved.next, movedIds);
      latestTodosRef.current = normalized.next;
      setTodos(normalized.next);

      try {
        setError(null);
        await Promise.all([
          persistCurrentOrder(),
          ...normalized.parentUpdates.map(async (update) => {
            await updateTodo(update.id, { parent_id: update.parent_id });
          }),
        ]);
        requestAnimationFrame(() => {
          todoCardRefs.current[activeId]?.focus();
        });
      } catch (reorderError) {
        latestTodosRef.current = snapshot;
        setTodos(snapshot);
        setError(
          reorderError instanceof Error
            ? reorderError.message
            : "Failed to move and reparent todo items.",
        );
      }
    },
    [canReorder, persistCurrentOrder, selectedTodoIds],
  );

  const nestFocusedSelectionIntoPrevious = useCallback(
    async (activeId: string) => {
      if (!hasSupabaseEnv || busyId || editingId) {
        return;
      }

      const snapshot = latestTodosRef.current;
      const selectedForAction =
        selectedTodoIds.length > 0 &&
        selectedTodoIds.includes(activeId)
          ? selectedTodoIds
          : [];
      const compacted = compactSelectionAtAnchor(
        snapshot,
        selectedForAction,
        activeId,
      );
      if (!compacted) {
        return;
      }

      if (compacted.anchorIndex === 0) {
        return;
      }

      const parent = compacted.compacted[compacted.anchorIndex - 1];
      if (!parent) {
        return;
      }

      const blockIds = compacted.block.map((todo) => todo.id);
      const parentLevelId = parent.parent_id;
      const shouldNestIntoParent =
        Boolean(parentLevelId) &&
        compacted.block.every((todo) => todo.parent_id === parentLevelId);
      const nextParentIdForBlock: string | null = parentLevelId
        ? shouldNestIntoParent
          ? parent.id
          : parentLevelId
        : parent.id;
      const next = normalizePositions(
        compacted.compacted.map((todo) => {
          if (!blockIds.includes(todo.id)) {
            return todo;
          }

          return { ...todo, parent_id: nextParentIdForBlock };
        }),
      );

      const changed = next.some((todo, index) => {
        const previous = snapshot[index];
        return (
          todo.id !== previous?.id || todo.parent_id !== previous?.parent_id
        );
      });
      if (!changed) {
        return;
      }

      setTodos(next);

      try {
        setError(null);
        await Promise.all(
          blockIds.map(async (todoId) => {
            const updatedTodo = next.find((todo) => todo.id === todoId);
            await updateTodo(todoId, { parent_id: updatedTodo?.parent_id ?? null });
          }),
        );
        await persistCurrentOrder();
      } catch (nestError) {
        setTodos(snapshot);
        setError(
          nestError instanceof Error
            ? nestError.message
            : "Failed to nest the selected todo items.",
        );
      }
    },
    [busyId, editingId, persistCurrentOrder, selectedTodoIds],
  );

  const unnestFocusedSelectionOneLevel = useCallback(
    async (activeId: string) => {
      if (!hasSupabaseEnv || busyId || editingId) {
        return;
      }

      const snapshot = latestTodosRef.current;
      const byId = new Map(snapshot.map((todo) => [todo.id, todo]));
      const targetIds =
        selectedTodoIds.length > 0 && selectedTodoIds.includes(activeId)
          ? selectedTodoIds
          : [activeId];

      const updates = targetIds
        .map((todoId) => {
          const todo = byId.get(todoId);
          if (!todo?.parent_id) {
            return null;
          }
          const parent = byId.get(todo.parent_id);
          const nextParentId = parent?.parent_id ?? null;
          if (nextParentId === todo.parent_id) {
            return null;
          }
          return { id: todoId, parent_id: nextParentId };
        })
        .filter(
          (
            value,
          ): value is {
            id: string;
            parent_id: string | null;
          } => Boolean(value),
        );

      if (updates.length === 0) {
        return;
      }

      const updateMap = new Map(updates.map((item) => [item.id, item.parent_id]));
      const next = snapshot.map((todo) =>
        updateMap.has(todo.id)
          ? { ...todo, parent_id: updateMap.get(todo.id) ?? null }
          : todo,
      );
      setTodos(next);

      try {
        setError(null);
        await Promise.all(
          updates.map(async (item) => {
            await updateTodo(item.id, { parent_id: item.parent_id });
          }),
        );
      } catch (unnestError) {
        setTodos(snapshot);
        setError(
          unnestError instanceof Error
            ? unnestError.message
            : "Failed to unnest the selected todo items.",
        );
      }
    },
    [busyId, editingId, selectedTodoIds],
  );

  const deleteFocusedSelection = useCallback(
    async (activeId: string) => {
      if (!hasSupabaseEnv || busyId || editingId) {
        return;
      }

      const snapshot = latestTodosRef.current;
      const targetIds = Array.from(
        new Set(
          selectedTodoIds.length > 0 && selectedTodoIds.includes(activeId)
            ? selectedTodoIds
            : [activeId],
        ),
      );
      if (targetIds.length === 0) {
        return;
      }

      const activeIndex = snapshot.findIndex((todo) => todo.id === activeId);
      const nextTodos = normalizePositions(
        snapshot.filter((todo) => !targetIds.includes(todo.id)),
      );

      latestTodosRef.current = nextTodos;
      setTodos(nextTodos);
      setSelectedTodoIds([]);
      setSelectionAnchorId(null);
      setBusyId("__bulk_delete__");

      try {
        setError(null);
        await Promise.all(targetIds.map(async (todoId) => deleteTodo(todoId)));
        await persistCurrentOrder();

        requestAnimationFrame(() => {
          if (nextTodos.length === 0) {
            return;
          }
          const focusIndex = Math.min(
            Math.max(activeIndex, 0),
            nextTodos.length - 1,
          );
          const nextFocusId = nextTodos[focusIndex]?.id;
          if (nextFocusId) {
            todoCardRefs.current[nextFocusId]?.focus();
          }
        });
      } catch (deleteError) {
        latestTodosRef.current = snapshot;
        setTodos(snapshot);
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : "Failed to delete focused todo items.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [busyId, editingId, persistCurrentOrder, selectedTodoIds],
  );

  const handleCreateFromAddCard = async () => {
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
      setIsAddCardActive(false);
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

  const startEdit = (todo: TodoRecord) => {
    editingSeedTextRef.current = todo.title;
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

    const targetId = editingId;
    const title = editingTitle.trim();
    if (!title) {
      try {
        setError(null);
        setBusyId(targetId);
        await deleteTodo(targetId);
        setTodos((previous) =>
          normalizePositions(previous.filter((item) => item.id !== targetId)),
        );
        cancelEdit();
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : "Failed to delete the todo.",
        );
      } finally {
        setBusyId(null);
      }
      return;
    }

    try {
      setError(null);
      setBusyId(targetId);
      const updated = await updateTodo(targetId, { title });
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
    activeId: string,
    dragPointerId: number,
    dragStartX: number,
  ) => {
    if (!canReorder) {
      return;
    }

    const previewIds =
      selectedTodoIds.length > 0 && selectedTodoIds.includes(activeId)
        ? selectedTodoIds
        : [activeId];

    setError(null);
    setDraggingIds(previewIds);
    setDragHorizontalIntent(null);

    let moved = false;
    let latestClientX = dragStartX;

    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== dragPointerId) {
        return;
      }

      moveEvent.preventDefault();
      latestClientX = moveEvent.clientX;
      const deltaX = latestClientX - dragStartX;
      if (deltaX >= CARD_HORIZONTAL_NEST_PX) {
        setDragHorizontalIntent("nest");
      } else if (deltaX <= -CARD_HORIZONTAL_NEST_PX) {
        setDragHorizontalIntent("unnest");
      } else {
        setDragHorizontalIntent(null);
      }
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
      setDraggingIds([]);
      setDragHorizontalIntent(null);
    };

    const handlePointerUp = async (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== dragPointerId) {
        return;
      }

      cleanup();
      const deltaX = latestClientX - dragStartX;
      const shouldNest = deltaX >= CARD_HORIZONTAL_NEST_PX;
      const shouldUnnest = deltaX <= -CARD_HORIZONTAL_NEST_PX;

      if (moved && positioningAvailable) {
        await persistCurrentOrder();
      }

      if (shouldNest) {
        await nestFocusedSelectionIntoPrevious(activeId);
      } else if (shouldUnnest) {
        await unnestFocusedSelectionOneLevel(activeId);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleCardPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    todo: TodoRecord,
  ) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button, input, textarea, select, a, [contenteditable='true']",
      )
    ) {
      return;
    }

    event.preventDefault();

    const pointerId = event.pointerId;
    const isShiftSelection = event.shiftKey;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragStarted = false;
    let allowEditOnRelease = true;

    const cleanup = () => {
      window.clearTimeout(holdTimer);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const deltaX = Math.abs(moveEvent.clientX - startX);
      const deltaY = Math.abs(moveEvent.clientY - startY);
      if (deltaX > CARD_MOVE_CANCEL_PX || deltaY > CARD_MOVE_CANCEL_PX) {
        allowEditOnRelease = false;
      }
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }

      cleanup();
      if (dragStarted) {
        return;
      }

      if (!allowEditOnRelease) {
        return;
      }

      if (isShiftSelection) {
        const focusedTodoId =
          (document.activeElement as HTMLElement | null)?.dataset?.todoId ?? null;
        const next = new Set(selectedTodoIds);
        if (next.size === 0 && focusedTodoId) {
          next.add(focusedTodoId);
        }

        const isRemoving = next.has(todo.id);
        if (isRemoving) {
          next.delete(todo.id);
        } else {
          next.add(todo.id);
        }

        const nextSelected = Array.from(next);
        setSelectedTodoIds(nextSelected);
        setSelectionAnchorId(nextSelected.length ? todo.id : null);

        if (isRemoving) {
          if (nextSelected.length === 0) {
            todoCardRefs.current[todo.id]?.blur();
          } else {
            todoCardRefs.current[nextSelected[0]]?.focus();
          }
        } else {
          todoCardRefs.current[todo.id]?.focus();
        }
        return;
      }

      setSelectedTodoIds([todo.id]);
      setSelectionAnchorId(todo.id);
      todoCardRefs.current[todo.id]?.focus();
    };

    const handlePointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) {
        return;
      }

      cleanup();
    };

    const holdTimer = window.setTimeout(() => {
      if (!canReorder) {
        return;
      }

      dragStarted = true;
      allowEditOnRelease = false;
      startDrag(todo.id, pointerId, startX);
    }, CARD_HOLD_TO_DRAG_MS);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  };

  const handleCardDoubleClick = (
    event: React.MouseEvent<HTMLElement>,
    todo: TodoRecord,
  ) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button, input, textarea, select, a, [contenteditable='true']",
      )
    ) {
      return;
    }

    if (!hasSupabaseEnv || busyId || editingId) {
      return;
    }

    setSelectedTodoIds([]);
    setSelectionAnchorId(null);
    startEdit(todo);
  };

  return (
    <main className="safe-area-shell">
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">
                Nest
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <button
                  type="button"
                  ref={completedToggleRef}
                  onClick={() => setShowCompleted((previous) => !previous)}
                  onKeyDown={(event) => {
                    void moveArrowFocus(event);
                  }}
                  aria-pressed={showCompleted}
                  title={showCompleted ? "Hide completed tasks" : "Show completed tasks"}
                >
                  {doneCount}/{todos.length} Completed ({showCompleted ? "Hide" : "Show"})
                </button>
                {isSavingOrder && <span>Saving order...</span>}
              </div>
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

            <div className="space-y-2">
              {isLoading && (
                <div className="rounded-lg border border-border/80 bg-muted/50 p-4 text-sm text-muted-foreground">
                  Loading tasks...
                </div>
              )}

              {hasSupabaseEnv && (
                <article
                  ref={addCardRowRef}
                  tabIndex={0}
                  onClick={() => {
                    if (!isAddCardActive) {
                      setIsAddCardActive(true);
                      return;
                    }

                    focusAddCardField();
                  }}
                  onKeyDown={(event) => {
                    if (moveArrowFocus(event)) {
                      return;
                    }
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    const isPrintableKey =
                      event.key.length === 1 &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.altKey;
                    if (!isAddCardActive && isPrintableKey) {
                      event.preventDefault();
                      setNewTitle(event.key);
                      setIsAddCardActive(true);
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activateAddCardEditor();
                    }
                  }}
                  className="px-0 py-3 transition hover:bg-muted/70 active:bg-muted/80"
                  aria-label="Add task"
                >
                  {isAddCardActive ? (
                    <div
                      className="flex items-center gap-2.5 px-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span
                        aria-hidden="true"
                        className="h-5 w-5 rounded-full border border-dashed border-muted-foreground/50"
                        onClick={(event) => {
                          event.stopPropagation();
                          focusAddCardField();
                        }}
                      />
                      <div
                        ref={addCardFieldRef}
                        contentEditable={!isAdding}
                        suppressContentEditableWarning
                        role="textbox"
                        aria-label="Add task"
                        onInput={(event) =>
                          setNewTitle((event.currentTarget.textContent ?? "").slice(0, 120))
                        }
                        className="block min-h-[1.25rem] w-full cursor-text break-words align-top text-left text-[16px] leading-[1.4] outline-none"
                        onBlur={() => {
                          if (skipNextAddBlurSaveRef.current) {
                            skipNextAddBlurSaveRef.current = false;
                            return;
                          }
                          void handleCreateFromAddCard();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            skipNextAddBlurSaveRef.current = true;
                            void handleCreateFromAddCard();
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            skipNextAddBlurSaveRef.current = true;
                            setIsAddCardActive(false);
                            setNewTitle("");
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2.5 px-1">
                      <span
                        aria-hidden="true"
                        className="h-5 w-5 rounded-full border border-dashed border-muted-foreground/50"
                        onClick={(event) => {
                          event.stopPropagation();
                          setIsAddCardActive(true);
                        }}
                      />
                      <span className="text-sm text-muted-foreground/60">&nbsp;</span>
                    </div>
                  )}
                </article>
              )}

              {!isLoading &&
                filteredTodos.map((todo) => {
                  const isBusy = busyId === todo.id;
                  const isEditing = editingId === todo.id;
                  const isDragging = draggingIds.includes(todo.id);
                  const isSelected = selectedTodoIdSet.has(todo.id);
                  const dragIntentShift =
                    isDragging && dragHorizontalIntent === "nest"
                      ? 16
                      : isDragging && dragHorizontalIntent === "unnest"
                        ? -16
                        : 0;
                  const depth = depthByTodoId[todo.id] ?? 0;

                  return (
                    <article
                      key={todo.id}
                      data-todo-id={todo.id}
                      tabIndex={0}
                      ref={(element) => {
                        todoCardRefs.current[todo.id] = element;
                      }}
                      onPointerDown={(event) => handleCardPointerDown(event, todo)}
                      onDoubleClick={(event) => handleCardDoubleClick(event, todo)}
                      onContextMenu={(event) => event.preventDefault()}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          event.key === "Escape"
                        ) {
                          event.preventDefault();
                          setSelectedTodoIds([]);
                          setSelectionAnchorId(null);
                          (event.currentTarget as HTMLElement).blur();
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "Backspace" || event.key === "Delete")
                        ) {
                          event.preventDefault();
                          void deleteFocusedSelection(todo.id);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          !event.repeat &&
                          event.metaKey &&
                          event.key === "ArrowLeft"
                        ) {
                          event.preventDefault();
                          void unnestFocusedSelectionOneLevel(todo.id);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          !event.repeat &&
                          event.metaKey &&
                          event.key === "ArrowRight"
                        ) {
                          event.preventDefault();
                          void nestFocusedSelectionIntoPrevious(todo.id);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          !event.repeat &&
                          event.metaKey &&
                          event.key === "ArrowUp"
                        ) {
                          event.preventDefault();
                          void moveFocusedSelectionByOffset(todo.id, -1);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          !event.repeat &&
                          event.metaKey &&
                          event.key === "ArrowDown"
                        ) {
                          event.preventDefault();
                          void moveFocusedSelectionByOffset(todo.id, 1);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          event.shiftKey &&
                          event.key === "ArrowUp"
                        ) {
                          event.preventDefault();
                          void moveShiftSelectionByOffset(todo.id, -1);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          event.shiftKey &&
                          event.key === "ArrowDown"
                        ) {
                          event.preventDefault();
                          void moveShiftSelectionByOffset(todo.id, 1);
                          return;
                        }
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "ArrowUp" || event.key === "ArrowDown")
                        ) {
                          setSelectedTodoIds([]);
                          setSelectionAnchorId(null);
                        }
                        if (moveArrowFocus(event)) {
                          return;
                        }
                        if (event.target !== event.currentTarget) {
                          return;
                        }
                        if (moveHorizontalFocusInCard(event, todo.id)) {
                          return;
                        }
                        if (event.key === " ") {
                          event.preventDefault();
                          void handleToggle(todo);
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (!hasSupabaseEnv || isBusy) {
                            return;
                          }
                          startEdit(todo);
                        }
                      }}
                      aria-label="Task card"
                      className={cn(
                        "relative overflow-visible px-0 py-3 transition hover:bg-muted/70 active:bg-muted/80",
                        todo.is_completed && "opacity-70",
                        isSelected && "bg-muted/60",
                        isDragging && "bg-muted/80",
                      )}
                      style={
                        isDragging || isSelected
                          ? {
                              outline: "auto",
                              outlineOffset: "2px",
                              transform:
                                dragIntentShift !== 0
                                  ? `translateX(${dragIntentShift}px)`
                                  : undefined,
                            }
                          : undefined
                      }
                    >
                      <div
                        className="relative flex items-start gap-2.5 px-1"
                      >
                        {depth > 0 && <div className="mr-1 shrink-0" style={{ width: `${depth * 16}px` }} />}
                        <button
                          type="button"
                          aria-label={
                            todo.is_completed
                              ? "Mark task as not completed"
                              : "Mark task as completed"
                          }
                          className={cn(
                            "h-5 w-5 rounded-full border transition",
                            todo.is_completed
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/60 bg-transparent hover:border-primary",
                          )}
                          ref={(element) => {
                            todoDoneRefs.current[todo.id] = element;
                          }}
                          onKeyDown={(event) => {
                            void moveHorizontalFocusInCard(event, todo.id);
                          }}
                          onClick={() => void handleToggle(todo)}
                          disabled={!hasSupabaseEnv}
                        />

                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <span
                              contentEditable={!isBusy}
                              suppressContentEditableWarning
                              role="textbox"
                              aria-label={`Edit task: ${todo.title}`}
                              onInput={(event) =>
                                setEditingTitle(event.currentTarget.textContent ?? "")
                              }
                              ref={(element) => {
                                editingFieldRefs.current[todo.id] = element;
                                todoTextRefs.current[todo.id] = element;
                              }}
                              className="inline-block max-w-full break-words align-top text-left text-[16px] leading-[1.35] outline-none"
                              onBlur={() => {
                                if (skipNextEditBlurSaveRef.current) {
                                  skipNextEditBlurSaveRef.current = false;
                                  return;
                                }
                                if (!busyId) {
                                  void saveEdit();
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void saveEdit();
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  skipNextEditBlurSaveRef.current = true;
                                  cancelEdit();
                                }
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEdit(todo)}
                              disabled={!hasSupabaseEnv || isBusy}
                              aria-label={`Edit task: ${todo.title}`}
                              ref={(element) => {
                                todoTextRefs.current[todo.id] = element;
                              }}
                              onKeyDown={(event) => {
                                void moveHorizontalFocusInCard(event, todo.id);
                              }}
                              className={cn(
                                "inline-block max-w-full break-words align-top text-left text-[16px] leading-[1.35]",
                                todo.is_completed &&
                                  "text-muted-foreground line-through",
                              )}
                            >
                              {todo.title}
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          aria-label={`Open task menu for: ${todo.title}`}
                          className="flex h-5 w-5 items-center justify-center text-muted-foreground"
                          ref={(element) => {
                            todoMenuRefs.current[todo.id] = element;
                          }}
                          onKeyDown={(event) => {
                            void moveHorizontalFocusInCard(event, todo.id);
                          }}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </button>

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
