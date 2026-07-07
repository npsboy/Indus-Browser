import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
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

type ChatMessage = {
  role: "user" | "conversant" | "system";
  content: string;
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
};

type ChatPageProps = {
  tabId: string;
  initialUrl: string;
  onUrlChange?: (newUrl: string) => void;
  onTitleChange?: (title: string) => void;
};

const STORAGE_KEY = "indus-browser.chats.v1";

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
  const initialChatTitle = useRef((urlObj.searchParams.get("title") || "").trim()).current;

  const [chats, setChats] = useState<ChatSession[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(existingChatId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [openMenuChatId, setOpenMenuChatId] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [welcomeQuote, setWelcomeQuote] = useState(pickWelcomeQuote);
  const [streamingReply, setStreamingReply] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isCancellingRename = useRef(false);
  const initialized = useRef(false);
  const loadingText = useLoadingText(isLoading);
  
  // Keep the tab URL in sync with the current chat ID
  useEffect(() => {
    if (onUrlChange) {
      if (currentChatId) {
        onUrlChange(`indus://chat?id=${currentChatId}`);
      } else {
        onUrlChange(`indus://chat`);
      }
    }
  }, [currentChatId, onUrlChange]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const loaded = loadChats();
    setChats(loaded);
    
    if (existingChatId) {
      const chat = loaded.find(c => c.id === existingChatId);
      if (chat) setMessages(chat.messages);
    } else if (initialQuery) {
      handleSend(initialQuery, loaded);
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
    const closeMenu = (event: MouseEvent) => {
      if (!chatMenuRef.current?.contains(event.target as Node)) {
        setOpenMenuChatId(null);
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
          updated = [{ id: activeId, title, messages, updatedAt: Date.now() }, ...prev];
        }
        updated.sort((a, b) => b.updatedAt - a.updatedAt);
        saveChats(updated);
        return updated;
      });
    }
  }, [messages]);

  const handleSend = async (text: string, _currentChats = chats) => {
    if (!text.trim()) return;
    
    const newMsg: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, newMsg];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      const payloadMessages = updatedMessages.map(m => ({
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  const startNewChat = () => {
    setCurrentChatId(null);
    setMessages([]);
    setIsSidebarOpen(false);
    setOpenMenuChatId(null);
    setEditingChatId(null);
    setWelcomeQuote(pickWelcomeQuote());
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
  };

  const currentChatTitle = chats.find(c => c.id === currentChatId)?.title || "New Chat";
  const isEmptyChat = messages.length === 0 && !isLoading;

  // Keep the browser tab's title in sync with the chat title
  useEffect(() => {
    onTitleChange?.(currentChatTitle);
  }, [currentChatTitle, onTitleChange]);

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
      <button className="chat-send-btn" onClick={() => handleSend(input)}>↑</button>
    </div>
  );

  return (
    <div className="chat-page-container">
      {isSidebarOpen && (
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <button className="new-chat-btn" onClick={startNewChat}>+ New chat</button>
            <div className="recents-header">Recents</div>
          </div>
          <div className="chat-list">
            {chats.map(chat => (
              <div 
                key={chat.id} 
                className={`chat-list-item ${chat.id === currentChatId ? 'active' : ''}`}
                onClick={() => {
                  setCurrentChatId(chat.id);
                  setMessages(chat.messages);
                  setIsSidebarOpen(false);
                }}
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
                    setOpenMenuChatId(openMenuChatId === chat.id ? null : chat.id);
                  }}
                >
                  <img src={moreIcon} alt="" />
                </button>
                {openMenuChatId === chat.id && (
                  <div className="chat-item-menu" ref={chatMenuRef} onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="chat-item-menu-option" onClick={() => renameChat(chat)}>
                      <img src={editIcon} alt="" />
                      <span>Rename</span>
                    </button>
                    <button type="button" className="chat-item-menu-option delete" onClick={() => deleteChat(chat.id)}>
                      <img src={deleteIcon} alt="" />
                      <span>Delete</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      <div className="chat-main">
        <div className="chat-header">
          <div className="chat-title-dropdown" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
            <span className="chat-title-text">{currentChatTitle}</span>
            <span className="dropdown-icon" aria-hidden="true">
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </div>
        
        {isEmptyChat ? (
          <div className="chat-empty-state">
            <img src={logo} alt="" className="chat-empty-logo" />
            <p className="chat-empty-quote">{welcomeQuote}</p>
            {chatInputBox}
          </div>
        ) : (
          <>
            <div className="chat-messages-container">
              <div className="chat-messages-pad">
                {messages.map((msg, i) => (
                  <div key={i} className={`chat-msg-row ${msg.role}`}>
                    <div className={`chat-bubble-inner ${msg.role}`}>
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                ))}
                {streamingReply !== null && (
                  <div className="chat-msg-row conversant">
                    <div className="chat-bubble-inner conversant">
                      <ReactMarkdown>{streamingReply}</ReactMarkdown>
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
