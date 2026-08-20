/* ══════════════════════════════════════════════════════════
   ChatWave — Main Application Logic
   ══════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────
let currentUser = null;
let socket = null;
let activeConversationId = null;
let activeOtherUser = null;
let conversations = [];
let typingTimer = null;
let isTyping = false;

// ─── DOM Refs ─────────────────────────────────────────────
const conversationsList = document.getElementById('conversationsList');
const emptyConversations = document.getElementById('emptyConversations');
const chatEmptyState = document.getElementById('chatEmptyState');
const activeChat = document.getElementById('activeChat');
const messagesArea = document.getElementById('messagesArea');
const messagesLoading = document.getElementById('messagesLoading');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const typingIndicator = document.getElementById('typingIndicator');
const toastContainer = document.getElementById('toastContainer');
const backBtn = document.getElementById('backBtn');
const sidebar = document.getElementById('sidebar');
const chatPanel = document.getElementById('chatPanel');

// ─── Utilities ────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatConvTime(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatTime(dateStr);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function avatarHtml(url, name, size = 48, classes = '') {
  if (url) {
    return `<img src="${url}" alt="${name}" class="${classes}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;">`;
  }
  const initial = (name || '?')[0].toUpperCase();
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#6c63ff,#a78bfa);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.floor(size*0.38)}px;color:white;flex-shrink:0;" class="${classes}">${initial}</div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (!data.user) return window.location.href = '/';
    if (!data.user.username) return window.location.href = '/setup.html';
    currentUser = data.user;
    renderCurrentUser();
    initSocket();
    await loadConversations();
    setupEventListeners();
  } catch (err) {
    showToast('Failed to load. Please refresh.', 'error');
  }
}

function renderCurrentUser() {
  document.getElementById('myUsername').textContent = '@' + currentUser.username;
  if (currentUser.avatar_url) {
    const img = document.getElementById('myAvatar');
    img.src = currentUser.avatar_url;
    img.style.display = 'block';
    document.getElementById('myAvatarPlaceholder').style.display = 'none';
  } else {
    const ph = document.getElementById('myAvatarPlaceholder');
    ph.textContent = currentUser.display_name?.[0]?.toUpperCase() || '?';
    ph.style.display = 'flex';
  }
}

// ─── Socket.io ────────────────────────────────────────────
function initSocket() {
  socket = io({ auth: { userId: currentUser.id } });

  socket.on('connect', () => console.log('🔌 Socket connected'));
  socket.on('disconnect', () => console.log('🔌 Socket disconnected'));

  socket.on('message:new', ({ conversationId, message }) => {
    // Update conversation list
    const conv = conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.last_message = message.content;
      conv.last_message_at = message.created_at;
      if (conversationId !== activeConversationId) {
        conv.unread_count = (parseInt(conv.unread_count) || 0) + 1;
      }
      renderConversations();
    } else {
      // New conversation from search — reload list
      loadConversations();
    }

    // Append to active chat
    if (conversationId === activeConversationId) {
      appendMessage(message);
      scrollToBottom();
      // Mark as read immediately
      socket.emit('messages:read', {
        conversationId,
        senderId: message.sender_id
      });
    }
  });

  socket.on('user:online', ({ userId }) => {
    conversations.forEach(c => {
      if (c.other_user_id === userId) c.other_is_online = true;
    });
    if (activeOtherUser?.id === userId) setHeaderOnline(true);
    renderConversations();
  });

  socket.on('user:offline', ({ userId }) => {
    conversations.forEach(c => {
      if (c.other_user_id === userId) c.other_is_online = false;
    });
    if (activeOtherUser?.id === userId) setHeaderOnline(false);
    renderConversations();
  });

  socket.on('typing:start', ({ conversationId }) => {
    if (conversationId === activeConversationId) {
      typingIndicator.classList.add('visible');
      scrollToBottom();
    }
  });

  socket.on('typing:stop', ({ conversationId }) => {
    if (conversationId === activeConversationId) {
      typingIndicator.classList.remove('visible');
    }
  });

  socket.on('messages:read', ({ conversationId }) => {
    if (conversationId === activeConversationId) {
      document.querySelectorAll('.read-tick').forEach(el => el.classList.add('read'));
    }
  });
}

// ─── Conversations ────────────────────────────────────────
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    conversations = data.conversations || [];
    renderConversations();
  } catch {
    showToast('Failed to load conversations', 'error');
  }
}

function renderConversations() {
  const items = conversations.filter(c => c.last_message);
  if (items.length === 0) {
    emptyConversations.style.display = 'flex';
    conversationsList.innerHTML = '';
    conversationsList.appendChild(emptyConversations);
    return;
  }

  emptyConversations.style.display = 'none';

  conversationsList.innerHTML = items.map(conv => `
    <div class="conversation-item ${conv.id === activeConversationId ? 'active' : ''}"
         data-id="${conv.id}"
         data-user-id="${conv.other_user_id}"
         id="conv-${conv.id}">
      <div class="conv-avatar-wrapper">
        ${avatarHtml(conv.other_avatar_url, conv.other_username || conv.other_display_name, 48, 'conv-avatar')}
        ${conv.other_is_online ? '<div class="online-dot"></div>' : ''}
      </div>
      <div class="conv-content">
        <div class="conv-top">
          <span class="conv-name">@${escapeHtml(conv.other_username || conv.other_display_name)}</span>
          <span class="conv-time">${conv.last_message_at ? formatConvTime(conv.last_message_at) : ''}</span>
        </div>
        <div class="conv-bottom">
          <span class="conv-last-message">${escapeHtml(conv.last_message || '')}</span>
          ${parseInt(conv.unread_count) > 0
            ? `<span class="unread-badge">${conv.unread_count}</span>`
            : ''}
        </div>
      </div>
    </div>
  `).join('');

  conversationsList.querySelectorAll('.conversation-item').forEach(el => {
    el.addEventListener('click', () => openConversation(
      parseInt(el.dataset.id),
      parseInt(el.dataset.userId)
    ));
  });
}

// ─── Open Conversation ────────────────────────────────────
async function openConversation(conversationId, otherUserId) {
  activeConversationId = conversationId;

  // Find other user info from conversations
  const conv = conversations.find(c => c.id === conversationId);
  activeOtherUser = conv ? {
    id: conv.other_user_id,
    username: conv.other_username,
    display_name: conv.other_display_name,
    avatar_url: conv.other_avatar_url,
    is_online: conv.other_is_online,
  } : null;

  // Reset unread
  if (conv) conv.unread_count = 0;
  renderConversations();

  // Mobile: show chat panel
  chatPanel.classList.add('visible');
  sidebar.classList.add('hidden');

  // Show chat UI
  chatEmptyState.style.display = 'none';
  activeChat.style.display = 'flex';

  // Update header
  renderChatHeader();

  // Load messages
  messagesArea.innerHTML = '';
  messagesArea.appendChild(messagesLoading);
  messagesLoading.style.display = 'flex';
  typingIndicator.classList.remove('visible');

  try {
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    const data = await res.json();

    messagesLoading.style.display = 'none';
    messagesArea.innerHTML = '';

    renderMessages(data.messages || []);
    scrollToBottom(false);

    messageInput.focus();
    sendBtn.disabled = false;
  } catch {
    showToast('Failed to load messages', 'error');
  }
}

function renderChatHeader() {
  if (!activeOtherUser) return;

  const avatarImg = document.getElementById('chatHeaderAvatar');
  const avatarPh = document.getElementById('chatHeaderAvatarPlaceholder');

  if (activeOtherUser.avatar_url) {
    avatarImg.src = activeOtherUser.avatar_url;
    avatarImg.style.display = 'block';
    avatarPh.style.display = 'none';
  } else {
    avatarPh.textContent = (activeOtherUser.username || '?')[0].toUpperCase();
    avatarPh.style.display = 'flex';
    avatarImg.style.display = 'none';
  }

  document.getElementById('chatHeaderName').textContent = '@' + (activeOtherUser.username || activeOtherUser.display_name);
  setHeaderOnline(activeOtherUser.is_online);
}

function setHeaderOnline(isOnline) {
  const status = document.getElementById('chatHeaderStatus');
  const dot = document.getElementById('chatHeaderOnlineDot');
  if (isOnline) {
    status.textContent = 'Online';
    status.classList.add('online');
    dot.style.display = 'block';
  } else {
    status.textContent = 'Offline';
    status.classList.remove('online');
    dot.style.display = 'none';
  }
}

// ─── Render Messages ──────────────────────────────────────
function renderMessages(messages) {
  let lastDate = null;

  messages.forEach(msg => {
    const msgDate = new Date(msg.created_at).toDateString();
    if (msgDate !== lastDate) {
      const divider = document.createElement('div');
      divider.className = 'message-date-divider';
      divider.innerHTML = `<span>${formatDate(msg.created_at)}</span>`;
      messagesArea.appendChild(divider);
      lastDate = msgDate;
    }
    appendMessage(msg, false);
  });
}

function appendMessage(msg, animate = true) {
  const isSent = msg.sender_id === currentUser.id;

  const wrap = document.createElement('div');
  wrap.className = `message-wrap ${isSent ? 'sent' : 'received'}`;
  wrap.dataset.msgId = msg.id;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${isSent ? 'sent' : 'received'}`;
  if (!animate) bubble.style.animation = 'none';

  bubble.innerHTML = `
    ${escapeHtml(msg.content).replace(/\n/g, '<br>')}
    <div class="message-meta">
      <span class="message-time">${formatTime(msg.created_at)}</span>
      ${isSent ? `<span class="read-tick ${msg.is_read ? 'read' : ''}">✓✓</span>` : ''}
    </div>
  `;

  if (!isSent) {
    wrap.innerHTML = avatarHtml(msg.sender_avatar, msg.sender_username, 28, 'message-avatar-small');
  }

  wrap.appendChild(bubble);
  messagesArea.appendChild(wrap);
}

function scrollToBottom(smooth = true) {
  messagesArea.scrollTo({
    top: messagesArea.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant',
  });
}

// ─── Send Message ─────────────────────────────────────────
function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !activeConversationId || !socket) return;

  socket.emit('message:send', {
    conversationId: activeConversationId,
    content,
  });

  messageInput.value = '';
  messageInput.style.height = 'auto';
  sendBtn.disabled = true;
  stopTyping();
}

// ─── Search ───────────────────────────────────────────────
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  clearTimeout(searchDebounce);

  if (q.length < 2) {
    searchResults.classList.remove('visible');
    return;
  }

  searchDebounce = setTimeout(() => searchUsers(q), 300);
});

async function searchUsers(q) {
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();

    if (!data.users || data.users.length === 0) {
      searchResults.innerHTML = `<div class="search-no-results">No users found for "${escapeHtml(q)}"</div>`;
    } else {
      searchResults.innerHTML = data.users.map(u => `
        <div class="search-result-item" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">
          ${avatarHtml(u.avatar_url, u.username, 38, 'search-result-avatar')}
          <div>
            <div class="search-result-name">@${escapeHtml(u.username)}</div>
            <div class="search-result-username">${escapeHtml(u.display_name || '')}</div>
          </div>
          ${u.is_online ? '<div style="margin-left:auto;width:8px;height:8px;background:var(--online-color);border-radius:50%;"></div>' : ''}
        </div>
      `).join('');

      searchResults.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('click', () => startConversationWith(
          parseInt(el.dataset.userId),
          el.dataset.username
        ));
      });
    }
    searchResults.classList.add('visible');
  } catch {
    showToast('Search failed', 'error');
  }
}

async function startConversationWith(userId, username) {
  searchInput.value = '';
  searchResults.classList.remove('visible');

  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Failed to open conversation', 'error');
      return;
    }

    const convId = data.conversation.id;

    // Check if already in list
    if (!conversations.find(c => c.id === convId)) {
      // Fetch user info and add to list temporarily
      const userRes = await fetch(`/api/users/profile/${username}`);
      const userData = await userRes.json();
      const u = userData.user;
      conversations.unshift({
        id: convId,
        other_user_id: u.id,
        other_username: u.username,
        other_display_name: u.display_name,
        other_avatar_url: u.avatar_url,
        other_is_online: u.is_online,
        last_message: null,
        last_message_at: new Date().toISOString(),
        unread_count: 0,
      });
      renderConversations();
    }

    openConversation(convId, userId);
  } catch {
    showToast('Failed to open conversation', 'error');
  }
}

// ─── Typing ───────────────────────────────────────────────
function startTyping() {
  if (!isTyping && activeOtherUser) {
    isTyping = true;
    socket.emit('typing:start', {
      conversationId: activeConversationId,
      receiverId: activeOtherUser.id,
    });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
}

function stopTyping() {
  if (isTyping && activeOtherUser) {
    isTyping = false;
    socket.emit('typing:stop', {
      conversationId: activeConversationId,
      receiverId: activeOtherUser.id,
    });
  }
}

// ─── Event Listeners ──────────────────────────────────────
function setupEventListeners() {
  // Send button
  sendBtn.addEventListener('click', sendMessage);

  // Message input — auto-resize + typing
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = messageInput.value.trim().length === 0;
    if (messageInput.value.trim().length > 0) startTyping();
  });

  // Enter to send (Shift+Enter for newline)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  // Close search on click outside
  document.addEventListener('click', (e) => {
    if (!document.getElementById('searchContainer').contains(e.target)) {
      searchResults.classList.remove('visible');
    }
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // Mobile back button
  backBtn.addEventListener('click', () => {
    chatPanel.classList.remove('visible');
    sidebar.classList.remove('hidden');
    activeConversationId = null;
    activeOtherUser = null;
  });
}

// ─── Boot ─────────────────────────────────────────────────
init();
