"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import {
  createTodo,
  deleteTodo,
  hasSupabaseEnv,
  listTodos,
  type TodoRecord,
  updateTodo,
  updateTodoPositions,
} from "@/lib/supabase/rest";
import { cn } from "@/lib/utils";

function normalizePositions(items: TodoRecord[]): TodoRecord[] {
  return items.map((todo, index) => ({ ...todo, position: index }));
}

const NEW_TASK_ACTIVE_ID = "__new_task__";
const MULTI_BUSY_ID = "__multi__";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

function resizeTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) {
    return;
  }
  const styles = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 24;
  element.style.height = "0px";
  const measuredHeight = element.scrollHeight;
  const isSingleLine = measuredHeight <= lineHeight + 1;
  element.style.height = `${isSingleLine ? lineHeight : measuredHeight}px`;
}

function buildDepthMap(items: TodoRecord[]): Record<string, number> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const cache = new Map<string, number>();

  const getDepth = (id: string, seen: Set<string>): number => {
    if (cache.has(id)) {
      return cache.get(id) ?? 0;
    }

    const item = byId.get(id);
    if (!item?.parent_id) {
      cache.set(id, 0);
      return 0;
    }

    if (seen.has(id) || !byId.has(item.parent_id)) {
      cache.set(id, 0);
      return 0;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const depth = getDepth(item.parent_id, nextSeen) + 1;
    cache.set(id, depth);
    return depth;
  };

  const depths: Record<string, number> = {};
  items.forEach((item) => {
    depths[item.id] = getDepth(item.id, new Set());
  });
  return depths;
}

function reorderBySiblingMove(
  items: TodoRecord[],
  activeId: string,
  direction: -1 | 1,
): TodoRecord[] | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parentKey = (item: TodoRecord) =>
    item.parent_id && byId.has(item.parent_id) ? item.parent_id : null;

  const childrenByParent = new Map<string | null, TodoRecord[]>();
  const pushChild = (key: string | null, item: TodoRecord) => {
    const current = childrenByParent.get(key);
    if (current) {
      current.push(item);
      return;
    }
    childrenByParent.set(key, [item]);
  };

  items.forEach((item) => pushChild(parentKey(item), item));

  const active = byId.get(activeId);
  if (!active) {
    return null;
  }

  const activeParentKey = parentKey(active);
  const siblings = childrenByParent.get(activeParentKey) ?? [];
  const currentIndex = siblings.findIndex((item) => item.id === activeId);
  if (currentIndex === -1) {
    return null;
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) {
    return null;
  }

  const reorderedSiblings = [...siblings];
  const [moved] = reorderedSiblings.splice(currentIndex, 1);
  reorderedSiblings.splice(nextIndex, 0, moved);
  childrenByParent.set(activeParentKey, reorderedSiblings);

  const ordered: TodoRecord[] = [];
  const visit = (key: string | null) => {
    const children = childrenByParent.get(key) ?? [];
    children.forEach((child) => {
      if (ordered.some((item) => item.id === child.id)) {
        return;
      }
      ordered.push(child);
      visit(child.id);
    });
  };

  visit(null);
  if (ordered.length !== items.length) {
    const seen = new Set(ordered.map((item) => item.id));
    items.forEach((item) => {
      if (!seen.has(item.id)) {
        ordered.push(item);
      }
    });
  }

  return normalizePositions(ordered);
}

export function TodoApp() {
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [showCompleted, setShowCompleted] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [activeTodoId, setActiveTodoId] = useState<string | null>(null);
  const [collapsedTodoIds, setCollapsedTodoIds] = useState<string[]>([]);
  const [selectedTodoIds, setSelectedTodoIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const newTaskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const taskTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const loadTodos = useCallback(async () => {
    if (!hasSupabaseEnv) {
      setIsLoading(false);
      return;
    }

    try {
      setError(null);
      const rows = await listTodos();
      setTodos(normalizePositions(rows));
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

  const handleDeleteSelection = useCallback(async () => {
    const targetIds = selectedTodoIds.length
      ? selectedTodoIds
      : activeTodoId && activeTodoId !== NEW_TASK_ACTIVE_ID
        ? [activeTodoId]
        : [];

    if (
      !hasSupabaseEnv ||
      !targetIds.length ||
      busyId
    ) {
      return;
    }

    const previousTodos = todos;
    const nextTodos = normalizePositions(
      previousTodos.filter((item) => !targetIds.includes(item.id)),
    );

    try {
      setError(null);
      setBusyId(MULTI_BUSY_ID);
      setTodos(nextTodos);
      await Promise.all(targetIds.map(async (id) => deleteTodo(id)));
      await updateTodoPositions(nextTodos.map((item) => item.id));
      if (editingId && targetIds.includes(editingId)) {
        setEditingId(null);
        setEditingTitle("");
      }
      setActiveTodoId(null);
      setSelectedTodoIds([]);
      setSelectionAnchorId(null);
    } catch (deleteError) {
      setTodos(previousTodos);
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete the todo.",
      );
    } finally {
      setBusyId(null);
    }
  }, [activeTodoId, busyId, editingId, selectedTodoIds, todos]);

  const doneCount = useMemo(
    () => todos.filter((todo) => todo.is_completed).length,
    [todos],
  );

  const depthByTodoId = useMemo(() => buildDepthMap(todos), [todos]);

  const filteredTodos = useMemo(
    () => (showCompleted ? todos : todos.filter((todo) => !todo.is_completed)),
    [showCompleted, todos],
  );
  const collapsedTodoIdSet = useMemo(
    () => new Set(collapsedTodoIds),
    [collapsedTodoIds],
  );
  const hasChildrenTodoIdSet = useMemo(() => {
    const parentIds = new Set<string>();
    todos.forEach((todo) => {
      if (todo.parent_id) {
        parentIds.add(todo.parent_id);
      }
    });
    return parentIds;
  }, [todos]);
  const visibleTodos = useMemo(() => {
    const byId = new Map(filteredTodos.map((todo) => [todo.id, todo]));
    return filteredTodos.filter((todo) => {
      let parentId = todo.parent_id;
      while (parentId) {
        if (collapsedTodoIdSet.has(parentId)) {
          return false;
        }
        const parent = byId.get(parentId);
        if (!parent) {
          break;
        }
        parentId = parent.parent_id;
      }
      return true;
    });
  }, [collapsedTodoIdSet, filteredTodos]);
  const selectedTodoIdSet = useMemo(
    () => new Set(selectedTodoIds),
    [selectedTodoIds],
  );

  useEffect(() => {
    const visibleIds = new Set(filteredTodos.map((todo) => todo.id));
    setSelectedTodoIds((previous) => previous.filter((id) => visibleIds.has(id)));
    setSelectionAnchorId((previous) =>
      previous && visibleIds.has(previous) ? previous : null,
    );
    if (
      activeTodoId &&
      activeTodoId !== NEW_TASK_ACTIVE_ID &&
      !visibleIds.has(activeTodoId)
    ) {
      setActiveTodoId(null);
    }
  }, [activeTodoId, filteredTodos]);

  useEffect(() => {
    setCollapsedTodoIds((previous) =>
      previous.filter((id) => hasChildrenTodoIdSet.has(id)),
    );
  }, [hasChildrenTodoIdSet]);

  useEffect(() => {
    const visibleIds = new Set(visibleTodos.map((todo) => todo.id));
    setSelectedTodoIds((previous) => previous.filter((id) => visibleIds.has(id)));
    setSelectionAnchorId((previous) =>
      previous && visibleIds.has(previous) ? previous : null,
    );
    if (
      activeTodoId &&
      activeTodoId !== NEW_TASK_ACTIVE_ID &&
      !visibleIds.has(activeTodoId)
    ) {
      setActiveTodoId(null);
    }
  }, [activeTodoId, visibleTodos]);

  useEffect(() => {
    resizeTextarea(newTaskInputRef.current);
  }, [newTitle]);

  useEffect(() => {
    visibleTodos.forEach((todo) => {
      resizeTextarea(taskTextareaRefs.current[todo.id] ?? null);
    });
  }, [visibleTodos, editingId, editingTitle]);

  useEffect(() => {
    if (!editingId) {
      return;
    }
    const element = taskTextareaRefs.current[editingId];
    if (!element) {
      return;
    }

    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(0, element.value.length);
      resizeTextarea(element);
    });
  }, [editingId]);

  const submitNewTask = useCallback(async () => {
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
      const created = await createTodo(title, todos.length);
      setTodos((previous) => normalizePositions([...previous, created]));
      setNewTitle("");
      setActiveTodoId(NEW_TASK_ACTIVE_ID);
      newTaskInputRef.current?.blur();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create the todo.",
      );
    } finally {
      setIsAdding(false);
    }
  }, [isAdding, newTitle, todos.length]);

  const handleNestActiveTodo = useCallback(async () => {
    const targetIds = selectedTodoIds.length
      ? selectedTodoIds
      : activeTodoId && activeTodoId !== NEW_TASK_ACTIVE_ID
        ? [activeTodoId]
        : [];

    if (
      !hasSupabaseEnv ||
      !targetIds.length ||
      busyId ||
      editingId
    ) {
      return;
    }

    const visibleOrder = visibleTodos.map((todo) => todo.id);
    const orderedTargetIds = [...targetIds].sort(
      (a, b) => visibleOrder.indexOf(a) - visibleOrder.indexOf(b),
    );
    const previousTodos = todos;
    let workingTodos = previousTodos;
    const updates: Array<{ id: string; parent_id: string | null }> = [];

    orderedTargetIds.forEach((id) => {
      const visible = visibleOrder
        .map((visibleId) => workingTodos.find((todo) => todo.id === visibleId))
        .filter((todo): todo is TodoRecord => Boolean(todo));
      const index = visible.findIndex((todo) => todo.id === id);
      if (index <= 0) {
        return;
      }

      const parent = visible[index - 1];
      const current = visible[index];
      if (!parent || !current) {
        return;
      }

      const depthMap = buildDepthMap(workingTodos);
      const currentDepth = depthMap[current.id] ?? 0;
      const parentDepth = depthMap[parent.id] ?? 0;
      const nextParentId =
        currentDepth < parentDepth ? parent.parent_id ?? null : parent.id;

      if (current.parent_id === nextParentId) {
        return;
      }

      updates.push({ id: current.id, parent_id: nextParentId });
      workingTodos = workingTodos.map((item) =>
        item.id === current.id ? { ...item, parent_id: nextParentId } : item,
      );
    });

    if (!updates.length) {
      return;
    }

    try {
      setError(null);
      setBusyId(MULTI_BUSY_ID);
      setTodos(workingTodos);
      await Promise.all(
        updates.map(async ({ id, parent_id }) => updateTodo(id, { parent_id })),
      );
    } catch (nestError) {
      setTodos(previousTodos);
      setError(
        nestError instanceof Error ? nestError.message : "Failed to nest the todo.",
      );
    } finally {
      setBusyId(null);
    }
  }, [activeTodoId, busyId, editingId, selectedTodoIds, todos, visibleTodos]);

  const handleUnnestActiveTodo = useCallback(async () => {
    const targetIds = selectedTodoIds.length
      ? selectedTodoIds
      : activeTodoId && activeTodoId !== NEW_TASK_ACTIVE_ID
        ? [activeTodoId]
        : [];

    if (
      !hasSupabaseEnv ||
      !targetIds.length ||
      busyId ||
      editingId
    ) {
      return;
    }

    const visibleOrder = visibleTodos.map((todo) => todo.id);
    const orderedTargetIds = [...targetIds].sort(
      (a, b) => visibleOrder.indexOf(a) - visibleOrder.indexOf(b),
    );
    const previousTodos = todos;
    let workingTodos = previousTodos;
    const updates: Array<{ id: string; parent_id: string | null }> = [];

    orderedTargetIds.forEach((id) => {
      const visible = visibleOrder
        .map((visibleId) => workingTodos.find((todo) => todo.id === visibleId))
        .filter((todo): todo is TodoRecord => Boolean(todo));
      const current = visible.find((todo) => todo.id === id);
      if (!current?.parent_id) {
        return;
      }

      const currentIndex = visible.findIndex((todo) => todo.id === id);
      const above = currentIndex > 0 ? visible[currentIndex - 1] : null;
      const depthMap = buildDepthMap(workingTodos);
      const currentDepth = depthMap[current.id] ?? 0;
      const aboveDepth = above ? (depthMap[above.id] ?? 0) : -1;
      const directParent = workingTodos.find((todo) => todo.id === current.parent_id);
      const oneLevelUpParentId = directParent?.parent_id ?? null;
      const alignWithAboveParentId = above ? (above.parent_id ?? null) : null;
      const nextParentId =
        above && currentDepth > aboveDepth ? alignWithAboveParentId : oneLevelUpParentId;

      if (nextParentId === current.parent_id) {
        return;
      }

      updates.push({ id: current.id, parent_id: nextParentId });
      workingTodos = workingTodos.map((item) =>
        item.id === current.id ? { ...item, parent_id: nextParentId } : item,
      );
    });

    if (!updates.length) {
      return;
    }

    try {
      setError(null);
      setBusyId(MULTI_BUSY_ID);
      setTodos(workingTodos);
      await Promise.all(
        updates.map(async ({ id, parent_id }) => updateTodo(id, { parent_id })),
      );
    } catch (unnestError) {
      setTodos(previousTodos);
      setError(
        unnestError instanceof Error
          ? unnestError.message
          : "Failed to unnest the todo.",
      );
    } finally {
      setBusyId(null);
    }
  }, [activeTodoId, busyId, editingId, selectedTodoIds, todos, visibleTodos]);

  const handleMoveActiveTodo = useCallback(
    async (direction: -1 | 1) => {
      if (
        !hasSupabaseEnv ||
        !activeTodoId ||
        activeTodoId === NEW_TASK_ACTIVE_ID ||
        busyId ||
        editingId
      ) {
        return;
      }

      const previousTodos = todos;
      const reordered = reorderBySiblingMove(previousTodos, activeTodoId, direction);
      if (!reordered) {
        return;
      }

      try {
        setError(null);
        setBusyId(activeTodoId);
        setTodos(reordered);
        await updateTodoPositions(reordered.map((item) => item.id));
      } catch (moveError) {
        setTodos(previousTodos);
        setError(
          moveError instanceof Error
            ? moveError.message
            : "Failed to reorder todos.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [activeTodoId, busyId, editingId, todos],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isTypingTarget(event.target)) {
          return;
        }
        setActiveTodoId(null);
        setSelectedTodoIds([]);
        setSelectionAnchorId(null);
        return;
      }

      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        if (!visibleTodos.length) {
          return;
        }

        event.preventDefault();
        const visibleIds = visibleTodos.map((todo) => todo.id);
        const direction = event.key === "ArrowUp" ? -1 : 1;
        const initialIndex = visibleIds.indexOf(activeTodoId ?? "");
        const currentIndex =
          initialIndex === -1 ? (direction < 0 ? visibleIds.length - 1 : 0) : initialIndex;
        const nextIndex = Math.max(
          0,
          Math.min(visibleIds.length - 1, currentIndex + direction),
        );
        const nextId = visibleIds[nextIndex];
        const anchorId =
          selectionAnchorId && visibleIds.includes(selectionAnchorId)
            ? selectionAnchorId
            : visibleIds[currentIndex];
        const anchorIndex = visibleIds.indexOf(anchorId);
        const start = Math.min(anchorIndex, nextIndex);
        const end = Math.max(anchorIndex, nextIndex);
        const range = visibleIds.slice(start, end + 1);

        setActiveTodoId(nextId);
        setSelectionAnchorId(anchorId);
        setSelectedTodoIds(range);
        return;
      }

      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        void handleMoveActiveTodo(event.key === "ArrowUp" ? -1 : 1);
        return;
      }

      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        const isMultiSelecting =
          selectedTodoIds.length > 1 &&
          Boolean(selectionAnchorId) &&
          selectionAnchorId !== NEW_TASK_ACTIVE_ID;
        const navigationBaseId = isMultiSelecting
          ? selectionAnchorId
          : activeTodoId;

        setSelectedTodoIds([]);
        setSelectionAnchorId(null);
        if (!visibleTodos.length) {
          setActiveTodoId(NEW_TASK_ACTIVE_ID);
          return;
        }

        const currentIndex = visibleTodos.findIndex(
          (todo) => todo.id === navigationBaseId,
        );

        if (event.key === "ArrowUp") {
          if (currentIndex === -1) {
            if (!navigationBaseId) {
              setActiveTodoId(NEW_TASK_ACTIVE_ID);
              return;
            }
            if (navigationBaseId === NEW_TASK_ACTIVE_ID) {
              setActiveTodoId(visibleTodos[visibleTodos.length - 1].id);
              return;
            }
            setActiveTodoId(visibleTodos[0].id);
            return;
          }
          const nextIndex = Math.max(0, currentIndex - 1);
          setActiveTodoId(visibleTodos[nextIndex].id);
          return;
        }

        if (currentIndex === -1) {
          if (!navigationBaseId) {
            setActiveTodoId(visibleTodos[0].id);
            return;
          }
          if (navigationBaseId === NEW_TASK_ACTIVE_ID) {
            return;
          }
          setActiveTodoId(visibleTodos[visibleTodos.length - 1].id);
          return;
        }
        if (currentIndex === visibleTodos.length - 1) {
          setActiveTodoId(NEW_TASK_ACTIVE_ID);
          return;
        }
        const nextIndex = currentIndex + 1;
        setActiveTodoId(visibleTodos[nextIndex].id);
        return;
      }

      if (
        event.key === "ArrowRight" &&
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        void handleNestActiveTodo();
        return;
      }

      if (
        event.key === "ArrowLeft" &&
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        void handleUnnestActiveTodo();
        return;
      }

      if (
        hasSupabaseEnv &&
        (!activeTodoId || activeTodoId === NEW_TASK_ACTIVE_ID) &&
        !editingId &&
        !isTypingTarget(event.target) &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        newTaskInputRef.current?.focus();
        setNewTitle((previous) => `${previous}${event.key}`);
        return;
      }

      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        (selectedTodoIds.length > 0 ||
          (activeTodoId && activeTodoId !== NEW_TASK_ACTIVE_ID)) &&
        !editingId &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        void handleDeleteSelection();
      }
    };

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (!cardRef.current?.contains(target)) {
        setActiveTodoId(null);
        setSelectedTodoIds([]);
        setSelectionAnchorId(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [
    activeTodoId,
    editingId,
    visibleTodos,
    handleDeleteSelection,
    handleMoveActiveTodo,
    handleNestActiveTodo,
    handleUnnestActiveTodo,
    selectedTodoIds.length,
    selectionAnchorId,
  ]);

  const toggleCollapsedTodo = useCallback((todoId: string) => {
    setCollapsedTodoIds((previous) =>
      previous.includes(todoId)
        ? previous.filter((id) => id !== todoId)
        : [...previous, todoId],
    );
  }, []);

  const handleToggle = async (todo: TodoRecord) => {
    if (!hasSupabaseEnv || busyId) {
      return;
    }

    const nextCompleted = !todo.is_completed;

    try {
      setError(null);
      setBusyId(todo.id);
      setTodos((previous) =>
        previous.map((item) =>
          item.id === todo.id ? { ...item, is_completed: nextCompleted } : item,
        ),
      );

      const updated = await updateTodo(todo.id, { is_completed: nextCompleted });
      setTodos((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (updateError) {
      setTodos((previous) =>
        previous.map((item) =>
          item.id === todo.id ? { ...item, is_completed: todo.is_completed } : item,
        ),
      );
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

  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void saveEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  };

  const handleNewTaskKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitNewTask();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (newTitle.length > 0) {
        setNewTitle("");
        setActiveTodoId(NEW_TASK_ACTIVE_ID);
        event.currentTarget.blur();
        return;
      }
      setActiveTodoId(null);
      event.currentTarget.blur();
    }
  };

  return (
    <main className="safe-area-shell">
      <div className="mx-auto w-full max-w-2xl">
        <Card ref={cardRef} className="select-none">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">
                Nest
              </p>
              <button
                type="button"
                onClick={() => setShowCompleted((previous) => !previous)}
                aria-pressed={showCompleted}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title={showCompleted ? "Hide completed tasks" : "Show completed tasks"}
              >
                {doneCount}/{todos.length} Completed
                {showCompleted ? (
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          </CardHeader>

          <CardContent className="space-y-0 select-none">
            {!hasSupabaseEnv && (
              <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
                Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to start syncing.
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground">
                {error}
              </div>
            )}

            {isLoading && (
              <div className="rounded-lg border border-border/80 bg-muted/50 p-4 text-sm text-muted-foreground">
                Loading tasks...
              </div>
            )}

            {!isLoading &&
              visibleTodos.map((todo) => {
                const isBusy = busyId === todo.id;
                const isEditing = editingId === todo.id;
                const isCollapsed = collapsedTodoIdSet.has(todo.id);
                const hasChildren = hasChildrenTodoIdSet.has(todo.id);

                return (
                  <article
                    key={todo.id}
                    onMouseDown={(event) => {
                      if (
                        (event.target as HTMLElement).closest("[data-task-text='true']") ||
                        (event.target as HTMLElement).closest("[data-collapse-toggle='true']")
                      ) {
                        return;
                      }
                      setActiveTodoId(todo.id);
                      setSelectedTodoIds([todo.id]);
                      setSelectionAnchorId(todo.id);
                    }}
                    className={cn(
                      "-mx-6 px-6 pt-2 pb-0 transition hover:bg-muted/40",
                      (activeTodoId === todo.id || selectedTodoIdSet.has(todo.id)) &&
                        "bg-muted/60",
                      todo.is_completed && "opacity-70",
                    )}
                  >
                    <div
                      className="flex items-start gap-2.5 px-1"
                      style={{ paddingLeft: `${(depthByTodoId[todo.id] ?? 0) * 10}px` }}
                    >
                      <button
                        type="button"
                        aria-label={
                          todo.is_completed
                            ? "Mark task as not completed"
                            : "Mark task as completed"
                        }
                        className={cn(
                          "mt-1 size-5 shrink-0 rounded-full border transition",
                          todo.is_completed
                            ? "border-primary bg-primary"
                            : "border-muted-foreground/60 bg-transparent hover:border-primary",
                        )}
                        onClick={() => void handleToggle(todo)}
                        disabled={!hasSupabaseEnv || isBusy}
                      />

                      <div className="min-w-0 flex-1 py-1">
                        <textarea
                          ref={(element) => {
                            taskTextareaRefs.current[todo.id] = element;
                          }}
                          value={isEditing ? editingTitle : todo.title}
                          readOnly={!isEditing}
                          tabIndex={isEditing ? 0 : -1}
                          onClick={() => {
                            if (!isEditing && hasSupabaseEnv && !isBusy) {
                              startEdit(todo);
                            }
                          }}
                          onChange={(event) => {
                            if (isEditing) {
                              setEditingTitle(event.target.value);
                            }
                          }}
                          onInput={(event) => resizeTextarea(event.currentTarget)}
                          onBlur={() => {
                            if (isEditing && !isBusy) {
                              void saveEdit();
                            }
                          }}
                          onKeyDown={(event) => {
                            if (isEditing) {
                              handleEditKeyDown(event);
                            }
                          }}
                          rows={1}
                          aria-label={`Edit task: ${todo.title}`}
                          data-task-text="true"
                          className={cn(
                            "m-0 w-full resize-none overflow-hidden appearance-none border-0 bg-transparent p-0 text-[16px] leading-6 outline-none",
                            !isEditing && "cursor-text select-none",
                            isEditing && "select-text",
                            todo.is_completed && "text-muted-foreground line-through",
                          )}
                        />
                      </div>
                      {hasChildren && (
                        <button
                          type="button"
                          data-collapse-toggle="true"
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={() => toggleCollapsedTodo(todo.id)}
                          className="mt-1 shrink-0 text-muted-foreground transition hover:text-foreground"
                          aria-label={isCollapsed ? "Show nested tasks" : "Hide nested tasks"}
                          title={isCollapsed ? "Show nested tasks" : "Hide nested tasks"}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="h-4 w-4" aria-hidden="true" />
                          )}
                        </button>
                      )}

                    </div>
                  </article>
                );
              })}

            {hasSupabaseEnv && (
              <form
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  void submitNewTask();
                }}
                onMouseDown={() => {
                  setActiveTodoId(NEW_TASK_ACTIVE_ID);
                  setSelectedTodoIds([]);
                  setSelectionAnchorId(null);
                }}
                className={cn(
                  "-mx-6 px-6 pt-2 pb-0 transition hover:bg-muted/40",
                  activeTodoId === NEW_TASK_ACTIVE_ID && "bg-muted/60",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-1 size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/50"
                  />
                  <div className="min-w-0 flex-1 py-1">
                    <textarea
                      ref={newTaskInputRef}
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      onInput={(event) => resizeTextarea(event.currentTarget)}
                      onKeyDown={handleNewTaskKeyDown}
                      placeholder="Add a task"
                      rows={1}
                      className="m-0 w-full resize-none overflow-hidden appearance-none border-0 bg-transparent p-0 text-[16px] leading-6 outline-none placeholder:text-muted-foreground/70"
                    />
                  </div>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
