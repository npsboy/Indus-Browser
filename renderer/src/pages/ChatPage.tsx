import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import "./ChatPage.css";
import deleteIcon from "../assets/Icons/Delete-Red.png";
import editIcon from "../assets/Icons/Edit-Grey.png";
import moreIcon from "../assets/Icons/More-Grey.png";
import logo from "../assets/logos/Logo-Orange.png";

const WELCOME_QUOTES = [
  '"The important thing is not to stop questioning." — Albert Einstein',
  "\"I don't know what I think until I write it down.\" — Joan Didion",
  '"The beginning is always today." — Mary Shelley',
  '"The unexamined life is not worth living." — Socrates (as recorded by Plato)',
  '"A problem well stated is a problem half solved." — Charles Kettering',
];

function pickWelcomeQuote() {
  return WELCOME_QUOTES[Math.floor(Math.random() * WELCOME_QUOTES.length)];
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight];

function MarkdownCodeBlock({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopyCode = () => {
    const text = wrapperRef.current?.querySelector("code")?.textContent || "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="chat-code-block" ref={wrapperRef}>
      <button type="button" className="chat-code-copy-btn" aria-label="Copy code" onClick={handleCopyCode}>
        <span className="material-symbols-outlined">{copied ? "check" : "content_copy"}</span>
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = { pre: MarkdownCodeBlock };

type ChatMessage = {
  role: "user" | "conversant" | "system";
  content: string;
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  projectId?: string;
};

type Project = {
  id: string;
  name: string;
  createdAt: number;
};

type ChatPageProps = {
  tabId: string;
  initialUrl: string;
  onUrlChange?: (newUrl: string) => void;
  onTitleChange?: (title: string) => void;
};

const STORAGE_KEY = "indus-browser.chats.v1";
const PROJECTS_STORAGE_KEY = "indus-browser.projects.v1";
const PROJECT_PREVIEW_LIMIT = 5;

function loadChats(): ChatSession[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveChats(chats: ChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}

function loadProjects(): Project[] {
  try {
    const data = localStorage.getItem(PROJECTS_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: Project[]) {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
}

function formatChatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function snippetFor(chat: ChatSession): string {
  const last = chat.messages[chat.messages.length - 1];
  if (!last) return "";
  return last.content.replace(/\s+/g, " ").trim().slice(0, 120);
}

function useLoadingText(isLoading: boolean) {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setDotCount(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setDotCount((current) => (current + 1) % 4);
    }, 400);

    return () => window.clearInterval(intervalId);
  }, [isLoading]);

  return `Loading${dotCount > 0 ? ` ${".".repeat(dotCount)}` : ""}`;
}

export default function ChatPage({ tabId: _tabId, initialUrl, onUrlChange, onTitleChange }: ChatPageProps) {
  const urlObj = new URL(initialUrl);
  const initialQuery = urlObj.searchParams.get("q") || "";
  const existingChatId = urlObj.searchParams.get("id");
  const initialProjectId = urlObj.searchParams.get("project");
  const initialChatTitle = useRef((urlObj.searchParams.get("title") || "").trim()).current;

  const [chats, setChats] = useState<ChatSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(existingChatId);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(existingChatId ? null : initialProjectId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isChatSearchOpen, setIsChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);
  const [movingChatId, setMovingChatId] = useState<string | null>(null);
  const [isTitleMenuOpen, setIsTitleMenuOpen] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({});
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Record<string, boolean>>({});
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [welcomeQuote, setWelcomeQuote] = useState(pickWelcomeQuote);
  const [streamingReply, setStreamingReply] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatSearchInputRef = useRef<HTMLInputElement>(null);
  const chatMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  const renameProjectInputRef = useRef<HTMLInputElement>(null);
  const isCancellingRename = useRef(false);
  const isCancellingProjectRename = useRef(false);
  const initialized = useRef(false);
  const loadingText = useLoadingText(isLoading);

  // Keep the tab URL in sync with the current chat / project context
  useEffect(() => {
    if (onUrlChange) {
      if (currentChatId) {
        onUrlChange(`indus://chat?id=${currentChatId}`);
      } else if (activeProjectId) {
        onUrlChange(`indus://chat?project=${activeProjectId}`);
      } else {
        onUrlChange(`indus://chat`);
      }
    }
  }, [currentChatId, activeProjectId, onUrlChange]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const loaded = loadChats();
    setChats(loaded);
    setProjects(loadProjects());

    if (existingChatId) {
      const chat = loaded.find(c => c.id === existingChatId);
      if (chat) setMessages(chat.messages);
    } else if (initialQuery) {
      handleSend(initialQuery);
    }
  }, [existingChatId, initialQuery]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (editingChatId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingChatId]);

  useEffect(() => {
    if (editingProjectId) {
      renameProjectInputRef.current?.focus();
      renameProjectInputRef.current?.select();
    }
  }, [editingProjectId]);

  useEffect(() => {
    if (isCreatingProject) {
      newProjectInputRef.current?.focus();
    }
  }, [isCreatingProject]);

  useEffect(() => {
    if (isChatSearchOpen) {
      chatSearchInputRef.current?.focus();
    }
  }, [isChatSearchOpen]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!chatMenuRef.current?.contains(event.target as Node)) {
        setOpenMenuChatId(null);
        setMovingChatId(null);
      }
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setOpenProjectMenuId(null);
      }
      if (!titleMenuRef.current?.contains(event.target as Node)) {
        setIsTitleMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, []);

  // Auto-resize textarea as input changes
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      const MAX_HEIGHT = 200;
      textarea.style.height = "auto";
      const newHeight = Math.min(textarea.scrollHeight, MAX_HEIGHT);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    }
  }, [input]);

  useEffect(() => {
    if (messages.length > 0) {
      const activeId = currentChatId || crypto.randomUUID();
      if (!currentChatId) setCurrentChatId(activeId);

      const title = initialChatTitle || (messages[0]?.content.slice(0, 40) + "..." || "New Chat");

      setChats(prev => {
        const existing = prev.find(c => c.id === activeId);
        let updated: ChatSession[];
        if (existing) {
          updated = prev.map(c => c.id === activeId ? { ...c, messages, updatedAt: Date.now() } : c);
        } else {
          updated = [{ id: activeId, title, messages, updatedAt: Date.now(), projectId: activeProjectId || undefined }, ...prev];
        }
        updated.sort((a, b) => b.updatedAt - a.updatedAt);
        saveChats(updated);
        return updated;
      });
    }
  }, [messages]);

  const requestReply = async (payloadHistory: ChatMessage[]) => {
    setIsLoading(true);

    try {
      const payloadMessages = payloadHistory.map(m => ({
        role: m.role === "conversant" ? "assistant" : m.role,
        content: m.content
      }));

      let accumulated = "";
      const result = await (window as any).api.chatStreamRequest(
        { agentRole: "conversant", messages: payloadMessages },
        (delta: string) => {
          accumulated += delta;
          setIsLoading(false);
          setStreamingReply(accumulated);
        }
      );

      if (!result.error) {
        if (accumulated) {
          setMessages(prev => [...prev, { role: "conversant", content: accumulated }]);
        } else if (result.data) {
          const replyText = typeof result.data.reply === "string" ? result.data.reply : JSON.stringify(result.data.reply);
          setMessages(prev => [...prev, { role: "conversant", content: replyText }]);
        }
      } else {
        console.error("Server error:", result.status, result.text);
        setMessages(prev => [...prev, { role: "system", content: `Error ${result.status}: ${result.text}` }]);
      }
    } catch (e) {
      console.error("Chat error", e);
      setMessages(prev => [...prev, { role: "system", content: `Network Error: ${String(e)}` }]);
    } finally {
      setStreamingReply(null);
      setIsLoading(false);
    }
  };

  const handleSend = async (text: string) => {
    if (!text.trim()) return;

    const newMsg: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, newMsg];
    setMessages(updatedMessages);
    setInput("");
    await requestReply(updatedMessages);
  };

  const regenerateLastReply = () => {
    if (isLoading) return;
    const lastIndex = messages.length - 1;
    if (lastIndex < 0 || messages[lastIndex].role !== "conversant") return;

    const truncated = messages.slice(0, lastIndex);
    setMessages(truncated);
    requestReply(truncated);
  };

  const handleCopy = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      window.setTimeout(() => {
        setCopiedIndex((current) => (current === index ? null : current));
      }, 1500);
    } catch (e) {
      console.error("Copy failed", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  const startNewChat = () => {
    setCurrentChatId(null);
    setActiveProjectId(null);
    setMessages([]);
    setOpenMenuChatId(null);
    setMovingChatId(null);
    setIsTitleMenuOpen(false);
    setEditingChatId(null);
    setWelcomeQuote(pickWelcomeQuote());
  };

  const openChat = (chat: ChatSession) => {
    setCurrentChatId(chat.id);
    setMessages(chat.messages);
    setOpenMenuChatId(null);
    setMovingChatId(null);
  };

  const openProject = (projectId: string) => {
    setCurrentChatId(null);
    setActiveProjectId(projectId);
    setMessages([]);
    setInput("");
    setOpenProjectMenuId(null);
    setOpenMenuChatId(null);
  };

  const renameChat = (chat: ChatSession) => {
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
    setOpenMenuChatId(null);
  };

  const commitRename = () => {
    if (!editingChatId) return;
    if (isCancellingRename.current) {
      isCancellingRename.current = false;
      return;
    }

    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      setEditingChatId(null);
      setEditingTitle("");
      return;
    }

    setChats(prev => {
      const updated = prev.map(c => c.id === editingChatId ? { ...c, title: nextTitle, updatedAt: Date.now() } : c);
      saveChats(updated);
      return updated;
    });
    setEditingChatId(null);
    setEditingTitle("");
  };

  const cancelRename = () => {
    isCancellingRename.current = true;
    setEditingChatId(null);
    setEditingTitle("");
  };

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  const deleteChat = (chatId: string) => {
    setChats(prev => {
      const updated = prev.filter(c => c.id !== chatId);
      saveChats(updated);
      return updated;
    });

    if (chatId === currentChatId) {
      setCurrentChatId(null);
      setMessages([]);
    }
    setOpenMenuChatId(null);
    setMovingChatId(null);
    setIsTitleMenuOpen(false);
  };

  const moveChatToProject = (chatId: string, projectId: string | null) => {
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, projectId: projectId || undefined, updatedAt: Date.now() } : c);
      saveChats(updated);
      return updated;
    });
    setMovingChatId(null);
    setOpenMenuChatId(null);
  };

  const handleChatDragStart = (event: React.DragEvent, chatId: string) => {
    event.dataTransfer.setData("text/plain", chatId);
    event.dataTransfer.effectAllowed = "move";
    setDraggedChatId(chatId);
  };

  const handleChatDragEnd = () => {
    setDraggedChatId(null);
    setDragOverTarget(null);
  };

  const handleDropTargetDragOver = (event: React.DragEvent, target: string) => {
    if (!draggedChatId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverTarget(target);
  };

  const handleDropTargetDragLeave = (target: string) => {
    setDragOverTarget((current) => (current === target ? null : current));
  };

  const handleProjectDrop = (event: React.DragEvent, projectId: string) => {
    event.preventDefault();
    const chatId = event.dataTransfer.getData("text/plain");
    if (chatId) moveChatToProject(chatId, projectId);
    setDraggedChatId(null);
    setDragOverTarget(null);
  };

  const handleRecentsDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const chatId = event.dataTransfer.getData("text/plain");
    if (chatId) moveChatToProject(chatId, null);
    setDraggedChatId(null);
    setDragOverTarget(null);
  };

  const createProject = () => {
    const name = newProjectName.trim();
    if (!name) {
      setIsCreatingProject(false);
      setNewProjectName("");
      return;
    }

    const project: Project = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    setProjects(prev => {
      const updated = [project, ...prev];
      saveProjects(updated);
      return updated;
    });
    setNewProjectName("");
    setIsCreatingProject(false);
  };

  const handleNewProjectKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createProject();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setIsCreatingProject(false);
      setNewProjectName("");
    }
  };

  const renameProject = (project: Project) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
    setOpenProjectMenuId(null);
  };

  const commitProjectRename = () => {
    if (!editingProjectId) return;
    if (isCancellingProjectRename.current) {
      isCancellingProjectRename.current = false;
      return;
    }

    const nextName = editingProjectName.trim();
    if (!nextName) {
      setEditingProjectId(null);
      setEditingProjectName("");
      return;
    }

    setProjects(prev => {
      const updated = prev.map(p => p.id === editingProjectId ? { ...p, name: nextName } : p);
      saveProjects(updated);
      return updated;
    });
    setEditingProjectId(null);
    setEditingProjectName("");
  };

  const cancelProjectRename = () => {
    isCancellingProjectRename.current = true;
    setEditingProjectId(null);
    setEditingProjectName("");
  };

  const handleProjectRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitProjectRename();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelProjectRename();
    }
  };

  const deleteProject = (projectId: string) => {
    setProjects(prev => {
      const updated = prev.filter(p => p.id !== projectId);
      saveProjects(updated);
      return updated;
    });

    setChats(prev => {
      const updated = prev.map(c => c.projectId === projectId ? { ...c, projectId: undefined } : c);
      saveChats(updated);
      return updated;
    });

    if (activeProjectId === projectId) {
      setActiveProjectId(null);
    }
    setOpenProjectMenuId(null);
  };

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds(prev => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjectIds(prev => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const currentChatTitle = chats.find(c => c.id === currentChatId)?.title || "New chat";
  const activeProject = activeProjectId ? projects.find(p => p.id === activeProjectId) || null : null;
  const isProjectView = !currentChatId && !!activeProject;
  const isEmptyChat = !isProjectView && messages.length === 0 && !isLoading;

  const trimmedSearch = chatSearchQuery.trim().toLowerCase();
  const isSearching = trimmedSearch.length > 0;
  const searchResults = isSearching
    ? chats.filter(c => c.title.toLowerCase().includes(trimmedSearch))
    : [];
  const unassignedChats = chats.filter(c => !c.projectId);
  const projectChatsMap = new Map<string, ChatSession[]>();
  projects.forEach(p => {
    projectChatsMap.set(p.id, chats.filter(c => c.projectId === p.id));
  });
  const activeProjectChats = activeProjectId ? (projectChatsMap.get(activeProjectId) || []) : [];

  // Keep the browser tab's title in sync with the current chat / project
  useEffect(() => {
    onTitleChange?.(isProjectView && activeProject ? activeProject.name : currentChatTitle);
  }, [currentChatTitle, isProjectView, activeProject, onTitleChange]);

  const renderChatListItem = (chat: ChatSession) => (
    <div
      key={chat.id}
      className={`chat-list-item ${chat.id === currentChatId ? 'active' : ''} ${draggedChatId === chat.id ? 'dragging' : ''}`}
      draggable={editingChatId !== chat.id}
      onDragStart={(event) => handleChatDragStart(event, chat.id)}
      onDragEnd={handleChatDragEnd}
      onClick={() => openChat(chat)}
    >
      {editingChatId === chat.id ? (
        <input
          ref={renameInputRef}
          className="chat-list-rename-input"
          value={editingTitle}
          onChange={(event) => setEditingTitle(event.target.value)}
          onBlur={commitRename}
          onKeyDown={handleRenameKeyDown}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="chat-list-item-title">{chat.title}</span>
      )}
      <button
        className="chat-list-more-btn"
        type="button"
        aria-label={`Open options for ${chat.title}`}
        onClick={(event) => {
          event.stopPropagation();
          setMovingChatId(null);
          setOpenMenuChatId(openMenuChatId === chat.id ? null : chat.id);
        }}
      >
        <img src={moreIcon} alt="" />
      </button>
      {openMenuChatId === chat.id && (
        <div className="chat-item-menu" ref={chatMenuRef} onClick={(event) => event.stopPropagation()}>
          {movingChatId === chat.id ? (
            <>
              <button type="button" className="chat-item-menu-option" onClick={() => moveChatToProject(chat.id, null)}>
                <span>No project</span>
              </button>
              {projects.map(p => (
                <button key={p.id} type="button" className="chat-item-menu-option" onClick={() => moveChatToProject(chat.id, p.id)}>
                  <span className="material-symbols-outlined">folder</span>
                  <span>{p.name}</span>
                </button>
              ))}
              {projects.length === 0 && (
                <div className="chat-item-menu-hint">No projects yet</div>
              )}
            </>
          ) : (
            <>
              <button type="button" className="chat-item-menu-option" onClick={() => renameChat(chat)}>
                <img src={editIcon} alt="" />
                <span>Rename</span>
              </button>
              <button type="button" className="chat-item-menu-option" onClick={() => setMovingChatId(chat.id)}>
                <span className="material-symbols-outlined">drive_file_move</span>
                <span>Move to project</span>
              </button>
              <button type="button" className="chat-item-menu-option delete" onClick={() => deleteChat(chat.id)}>
                <img src={deleteIcon} alt="" />
                <span>Delete</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  const chatInputBox = (
    <div className="chat-input-wrapper">
      <textarea
        ref={textareaRef}
        placeholder="Write a message..."
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          minHeight: '44px',
          padding: '12px 16px',
          fontSize: '15px',
          resize: 'none',
          overflowY: 'hidden'
        }}
        rows={1}
      />
      <button className="chat-send-btn" onClick={() => handleSend(input)} aria-label="Send message">
        <span className="material-symbols-outlined">arrow_upward</span>
      </button>
    </div>
  );

  return (
    <div className="chat-page-container">
      {isSidebarOpen && (
        <div className="chat-sidebar">
          <div className="chat-sidebar-top">
            <div className="chat-sidebar-brand">
              <img src={logo} alt="" className="chat-sidebar-brand-logo" />
              <span>Indus</span>
            </div>
            <div className="chat-sidebar-top-actions">
              <button
                type="button"
                className="chat-icon-btn"
                aria-label="Search chats"
                onClick={() => setIsChatSearchOpen((open) => !open)}
              >
                <span className="material-symbols-outlined">search</span>
              </button>
              <button
                type="button"
                className="chat-icon-btn"
                aria-label="Close sidebar"
                onClick={() => setIsSidebarOpen(false)}
              >
                <span className="material-symbols-outlined">left_panel_close</span>
              </button>
            </div>
          </div>

          <div className="chat-sidebar-body">
            <button className="new-chat-btn" onClick={startNewChat}>
              <span className="material-symbols-outlined">edit_square</span>
              New chat
            </button>

            {isChatSearchOpen && (
              <input
                ref={chatSearchInputRef}
                className="chat-sidebar-search-input"
                placeholder="Search chats..."
                value={chatSearchQuery}
                onChange={(event) => setChatSearchQuery(event.target.value)}
              />
            )}

            {!isSearching && (
              <div className="projects-header-row">
                <span className="recents-header">Projects</span>
                <button
                  type="button"
                  className="chat-icon-btn small"
                  aria-label="New project"
                  onClick={() => setIsCreatingProject(true)}
                >
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
            )}

            {!isSearching && isCreatingProject && (
              <input
                ref={newProjectInputRef}
                className="chat-sidebar-search-input project-create-input"
                placeholder="Project name..."
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                onBlur={createProject}
                onKeyDown={handleNewProjectKeyDown}
              />
            )}

            {isSearching ? (
              <div className="chat-sidebar-scroll">
                <div className="recents-header">Search results</div>
                <div className="chat-list">
                  {searchResults.map(renderChatListItem)}
                  {searchResults.length === 0 && (
                    <div className="chat-list-empty">No chats found</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="chat-sidebar-scroll">
                <div className="chat-sidebar-section">
                  {projects.map(project => {
                    const projectChats = projectChatsMap.get(project.id) || [];
                    const isExpanded = !!expandedProjectIds[project.id];
                    const isCollapsed = !!collapsedProjectIds[project.id];
                    const visibleChats = isExpanded ? projectChats : projectChats.slice(0, PROJECT_PREVIEW_LIMIT);
                    const hasMore = projectChats.length > PROJECT_PREVIEW_LIMIT;

                    return (
                      <div
                        key={project.id}
                        className={`project-group ${dragOverTarget === project.id ? 'drag-over' : ''}`}
                        onDragOver={(event) => handleDropTargetDragOver(event, project.id)}
                        onDragLeave={() => handleDropTargetDragLeave(project.id)}
                        onDrop={(event) => handleProjectDrop(event, project.id)}
                      >
                        <div
                          className={`project-row ${activeProjectId === project.id && !currentChatId ? 'active' : ''}`}
                          onClick={() => openProject(project.id)}
                        >
                          <button
                            type="button"
                            className="project-collapse-btn"
                            aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleProjectCollapsed(project.id);
                            }}
                          >
                            <span className="material-symbols-outlined">
                              {isCollapsed ? "chevron_right" : "expand_more"}
                            </span>
                          </button>
                          <span className="material-symbols-outlined project-row-icon">folder</span>
                          {editingProjectId === project.id ? (
                            <input
                              ref={renameProjectInputRef}
                              className="chat-list-rename-input"
                              value={editingProjectName}
                              onChange={(event) => setEditingProjectName(event.target.value)}
                              onBlur={commitProjectRename}
                              onKeyDown={handleProjectRenameKeyDown}
                              onClick={(event) => event.stopPropagation()}
                            />
                          ) : (
                            <span className="chat-list-item-title">{project.name}</span>
                          )}
                          <button
                            className="chat-list-more-btn"
                            type="button"
                            aria-label={`Open options for ${project.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenProjectMenuId(openProjectMenuId === project.id ? null : project.id);
                            }}
                          >
                            <img src={moreIcon} alt="" />
                          </button>
                          {openProjectMenuId === project.id && (
                            <div className="chat-item-menu" ref={projectMenuRef} onClick={(event) => event.stopPropagation()}>
                              <button type="button" className="chat-item-menu-option" onClick={() => renameProject(project)}>
                                <img src={editIcon} alt="" />
                                <span>Rename</span>
                              </button>
                              <button type="button" className="chat-item-menu-option delete" onClick={() => deleteProject(project.id)}>
                                <img src={deleteIcon} alt="" />
                                <span>Delete</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {!isCollapsed && visibleChats.length > 0 && (
                          <div className="project-chat-list">
                            {visibleChats.map(chat => (
                              <div
                                key={chat.id}
                                className={`project-chat-item ${chat.id === currentChatId ? 'active' : ''} ${draggedChatId === chat.id ? 'dragging' : ''}`}
                                draggable
                                onDragStart={(event) => handleChatDragStart(event, chat.id)}
                                onDragEnd={handleChatDragEnd}
                                onClick={() => openChat(chat)}
                              >
                                {chat.title}
                              </div>
                            ))}
                            {hasMore && (
                              <button
                                type="button"
                                className="project-show-more-btn"
                                onClick={() => toggleProjectExpanded(project.id)}
                              >
                                {isExpanded ? "Show less" : `Show more (${projectChats.length - PROJECT_PREVIEW_LIMIT})`}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  className={`chat-sidebar-section ${dragOverTarget === 'recents' ? 'drag-over' : ''}`}
                  onDragOver={(event) => handleDropTargetDragOver(event, 'recents')}
                  onDragLeave={() => handleDropTargetDragLeave('recents')}
                  onDrop={handleRecentsDrop}
                >
                  <div className="recents-header">Recents</div>
                  <div className="chat-list">
                    {unassignedChats.map(renderChatListItem)}
                    {unassignedChats.length === 0 && (
                      <div className="chat-list-empty">No chats yet</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="chat-main">
        <div className="chat-header">
          {!isSidebarOpen && (
            <button
              type="button"
              className="chat-icon-btn"
              aria-label="Open sidebar"
              onClick={() => setIsSidebarOpen(true)}
            >
              <span className="material-symbols-outlined">left_panel_open</span>
            </button>
          )}

          {isProjectView && activeProject ? (
            <div className="chat-title-dropdown" onClick={() => setIsTitleMenuOpen((open) => !open)}>
              <span className="material-symbols-outlined chat-project-header-icon">folder</span>
              <span className="chat-title-text">{activeProject.name}</span>
              <span className="dropdown-icon" aria-hidden="true">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                  <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {isTitleMenuOpen && (
                <div className="chat-item-menu chat-title-menu" ref={titleMenuRef} onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="chat-item-menu-option"
                    onClick={() => {
                      renameProject(activeProject);
                      setIsTitleMenuOpen(false);
                    }}
                  >
                    <img src={editIcon} alt="" />
                    <span>Rename</span>
                  </button>
                  <button
                    type="button"
                    className="chat-item-menu-option delete"
                    onClick={() => deleteProject(activeProject.id)}
                  >
                    <img src={deleteIcon} alt="" />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="chat-title-dropdown" onClick={() => currentChatId && setIsTitleMenuOpen((open) => !open)}>
              <span className="chat-title-text">{currentChatTitle}</span>
              {currentChatId && (
                <span className="dropdown-icon" aria-hidden="true">
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              {isTitleMenuOpen && currentChatId && (
                <div className="chat-item-menu chat-title-menu" ref={titleMenuRef} onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="chat-item-menu-option"
                    onClick={() => {
                      const chat = chats.find(c => c.id === currentChatId);
                      if (chat) renameChat(chat);
                      setIsTitleMenuOpen(false);
                    }}
                  >
                    <img src={editIcon} alt="" />
                    <span>Rename</span>
                  </button>
                  <button
                    type="button"
                    className="chat-item-menu-option delete"
                    onClick={() => deleteChat(currentChatId)}
                  >
                    <img src={deleteIcon} alt="" />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {isProjectView && activeProject ? (
          <div className="chat-project-view">
            <div className="chat-project-input-row">
              <div className="chat-input-wrapper">
                <textarea
                  ref={textareaRef}
                  placeholder={`New chat in ${activeProject.name}`}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  style={{
                    minHeight: '44px',
                    padding: '12px 16px',
                    fontSize: '15px',
                    resize: 'none',
                    overflowY: 'hidden'
                  }}
                  rows={1}
                />
                <button className="chat-send-btn" onClick={() => handleSend(input)} aria-label="Send message">
                  <span className="material-symbols-outlined">arrow_upward</span>
                </button>
              </div>
            </div>

            <div className="chat-project-list">
              {activeProjectChats.length === 0 ? (
                <div className="chat-project-empty">No chats in this project yet.</div>
              ) : (
                activeProjectChats.map(chat => (
                  <div key={chat.id} className="chat-project-list-item" onClick={() => openChat(chat)}>
                    <div className="chat-project-list-main">
                      <div className="chat-project-list-title">{chat.title}</div>
                      <div className="chat-project-list-snippet">{snippetFor(chat)}</div>
                    </div>
                    <div className="chat-project-list-date">{formatChatDate(chat.updatedAt)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : isEmptyChat ? (
          <div className="chat-empty-state">
            <div className="chat-empty-heading">
              <img src={logo} alt="" className="chat-empty-logo" />
              <p className="chat-empty-quote">{welcomeQuote}</p>
            </div>
            {chatInputBox}
          </div>
        ) : (
          <>
            <div className="chat-messages-container">
              <div className="chat-messages-pad">
                {messages.map((msg, i) => {
                  const isLastConversant = msg.role === "conversant" && i === messages.length - 1 && streamingReply === null;
                  return (
                    <div key={i} className={`chat-msg-row ${msg.role}`}>
                      <div className={`chat-bubble-inner ${msg.role}`}>
                        <ReactMarkdown
                          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                          rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                          components={MARKDOWN_COMPONENTS}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                      {msg.role === "conversant" && (
                        <div className="chat-msg-actions">
                          <button
                            type="button"
                            className="chat-icon-btn small"
                            aria-label="Copy message"
                            onClick={() => handleCopy(msg.content, i)}
                          >
                            <span className="material-symbols-outlined">
                              {copiedIndex === i ? "check" : "content_copy"}
                            </span>
                          </button>
                          {isLastConversant && !isLoading && (
                            <button
                              type="button"
                              className="chat-icon-btn small"
                              aria-label="Regenerate response"
                              onClick={regenerateLastReply}
                            >
                              <span className="material-symbols-outlined">refresh</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {streamingReply !== null && (
                  <div className="chat-msg-row conversant">
                    <div className="chat-bubble-inner conversant">
                      <ReactMarkdown
                        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                        components={MARKDOWN_COMPONENTS}
                      >
                        {streamingReply}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                {isLoading && streamingReply === null && <div className="chat-msg-row conversant"><div className="chat-bubble-inner conversant">{loadingText}</div></div>}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="chat-input-area">
              {chatInputBox}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
