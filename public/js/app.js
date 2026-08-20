// ═══════════════════════════════════════════════════════════════════════════
// ChatWave App — Frontend Logic
// ═══════════════════════════════════════════════════════════════════════════

let currentUser = null;
let socket = null;
let activeChat = null; // { type: 'dm'|'group', id, name, participantId? }
let conversations = [];
let groups = [];
let friends = [];
let pendingRequests = [];
let unreadCounts = {};
let selectedMembers = new Set();
let typingTimer = null;

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/api/users/me');
    if (!res.ok) { window.location.href = '/'; return; }
    currentUser = await res.json();
  } catch {
    window.location.href = '/';
    return;
  }

  // Populate sidebar user info
  const avatarEl = document.getElementById('sidebarAvatar');
  if (currentUser.avatar_url) {
    avatarEl.src = currentUser.avatar_url;
  } else {
    avatarEl.style.display = 'none';
  }
  document.getElementById('sidebarUsername').textContent = currentUser.display_name || currentUser.username;
  if (document.getElementById('sidebarHandle')) {
    document.getElementById('sidebarHandle').textContent = `@${currentUser.username}`;
  }
  document.getElementById('dashName').textContent = currentUser.display_name || currentUser.username;
  document.getElementById('dashHandle').textContent = currentUser.username;

  // Connect socket
  socket = io({ auth: { userId: currentUser.id } });
  setupSocketListeners();

  // Load data
  await Promise.all([loadConversations(), loadGroups(), loadFriends()]);
  renderConversationList();

  // Nav
  setupNav();
  setupGroupModal();
  setupMessageInput();
  setupSearch();
  
  const mobileBackBtn = document.getElementById('mobileBackBtn');
  if (mobileBackBtn) {
    mobileBackBtn.addEventListener('click', () => {
      document.querySelector('.app-layout').classList.remove('mobile-chat-open');
    });
  }
}

// ─── Socket Listeners ──────────────────────────────────────────────────────
function setupSocketListeners() {
  socket.on('connect', () => console.log('🔌 Socket connected'));

  // DM messages
  socket.on('message:new', ({ conversationId, message }) => {
    if (activeChat?.type === 'dm' && activeChat.id === conversationId) {
      appendMessage(message, 'dm');
      socket.emit('messages:read', { conversationId, senderId: message.sender_id });
    } else {
      unreadCounts[`dm_${conversationId}`] = (unreadCounts[`dm_${conversationId}`] || 0) + 1;
    }
    updateConvPreview('dm', conversationId, message.content);
    renderConversationList();
  });

  // Group messages
  socket.on('group:message', ({ groupId, message }) => {
    if (activeChat?.type === 'group' && activeChat.id === groupId) {
      appendMessage(message, 'group');
    } else {
      unreadCounts[`group_${groupId}`] = (unreadCounts[`group_${groupId}`] || 0) + 1;
    }
    updateConvPreview('group', groupId, message.content);
    renderConversationList();
  });

  // Typing
  socket.on('typing:start', ({ conversationId }) => {
    if (activeChat?.type === 'dm' && activeChat.id === conversationId) showTyping();
  });
  socket.on('typing:stop', ({ conversationId }) => {
    if (activeChat?.type === 'dm' && activeChat.id === conversationId) hideTyping();
  });
  socket.on('group:typing:start', ({ groupId }) => {
    if (activeChat?.type === 'group' && activeChat.id === groupId) showTyping();
  });
  socket.on('group:typing:stop', ({ groupId }) => {
    if (activeChat?.type === 'group' && activeChat.id === groupId) hideTyping();
  });

  // Online status
  socket.on('user:online', ({ userId }) => updateUserOnline(userId, true));
  socket.on('user:offline', ({ userId }) => updateUserOnline(userId, false));
}

function showTyping() {
  document.getElementById('typingIndicator').classList.remove('hidden');
  scrollToBottom();
}
function hideTyping() {
  document.getElementById('typingIndicator').classList.add('hidden');
}

// ─── Data Loading ──────────────────────────────────────────────────────────
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    if (res.ok) {
      const data = await res.json();
      conversations = data.conversations || data || [];
      // Use server-side unread counts
      conversations.forEach(c => {
        if (c.unread_count > 0) unreadCounts[`dm_${c.id}`] = parseInt(c.unread_count);
      });
    }
  } catch (e) { console.error('Load conversations error:', e); }
}

async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    if (res.ok) groups = await res.json();
  } catch (e) { console.error('Load groups error:', e); }
}

async function loadFriends() {
  try {
    const res = await fetch('/api/friends');
    if (res.ok) {
      const data = await res.json();
      friends = data.friends || [];
      pendingRequests = data.pending || [];
    }
  } catch (e) { console.error('Load friends error:', e); }
}

// ─── Render Conversation List ─────────────────────────────────────────────
function renderConversationList(filter = '') {
  const list = document.getElementById('convList');
  const empty = document.getElementById('convEmptyState');

  // Combine DMs + groups into one sortable list
  const items = [];
  conversations.forEach(c => {
    const participantId = c.other_user_id;
    const name = c.other_display_name || c.other_username || 'Unknown';
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
    items.push({
      type: 'dm',
      id: c.id,
      name,
      avatar: c.other_avatar_url,
      sub: null,
      preview: c.last_message || 'No messages yet',
      time: c.last_message_at,
      unread: unreadCounts[`dm_${c.id}`] || 0,
      isOnline: c.other_is_online,
      participantId,
    });
  });
  groups.forEach(g => {
    if (filter && !g.name.toLowerCase().includes(filter.toLowerCase())) return;
    items.push({
      type: 'group',
      id: g.id,
      name: g.name,
      avatar: null,
      sub: `Group · ${g.member_count} members`,
      preview: g.last_message || 'No messages yet',
      time: g.last_message_at,
      unread: unreadCounts[`group_${g.id}`] || 0,
    });
  });

  // Include friends who don't have an active conversation yet
  const existingDmIds = new Set(conversations.map(c => c.other_user_id));
  friends.forEach(f => {
    if (existingDmIds.has(f.id)) return; // Already in the list
    const name = f.display_name || f.username || 'Unknown';
    if (filter && !name.toLowerCase().includes(filter.toLowerCase()) && !f.username.toLowerCase().includes(filter.toLowerCase())) return;
    items.push({
      type: 'new_dm',
      id: f.id, // passing the user id instead of conversation id
      name,
      avatar: f.avatar_url,
      sub: `@${f.username}`,
      preview: 'Start a new conversation',
      time: null, // will sort to bottom
      unread: 0,
      isOnline: f.is_online,
      participantId: f.id,
    });
  });

  // Sort by latest message
  items.sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return new Date(b.time) - new Date(a.time);
  });

  if (items.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }
  empty.classList.add('hidden');

  // Update total unread badge
  const totalUnread = items.reduce((sum, i) => sum + i.unread, 0);
  const badge = document.getElementById('totalUnreadBadge');
  if (totalUnread > 0) {
    badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // Update stats
  document.getElementById('statConversations').textContent = conversations.length;
  document.getElementById('statGroups').textContent = groups.length;
  document.getElementById('statOnline').textContent = friends.filter(u => u.is_online).length;

  list.innerHTML = items.map(item => {
    const isActive = activeChat?.type === item.type && activeChat?.id === item.id;
    const timeStr = item.time ? formatTime(new Date(item.time)) : '';
    const avatarHtml = item.type === 'group'
      ? `<div class="group-avatar">👥</div>`
      : `<div class="conv-avatar-wrap">
           ${item.avatar
             ? `<img src="${item.avatar}" class="conv-avatar" style="border-radius:50%" />`
             : `<div class="conv-avatar"><div class="avatar-placeholder">${(item.name[0]||'?').toUpperCase()}</div></div>`
           }
           ${item.isOnline ? '<span class="conv-online"></span>' : ''}
         </div>`;

    const onclickAction = item.type === 'new_dm'
      ? `startDM(${item.id}, '${escHtml(item.name)}', '${escHtml(item.avatar || '')}')`
      : `openChat('${item.type}', ${item.id}, '${escHtml(item.name)}', ${item.participantId || 'null'}, '${escHtml(item.avatar || '')}', '${escHtml(item.sub || '')}')`;

    return `<div class="conv-item ${isActive ? 'active' : ''}" 
               onclick="${onclickAction}">
      ${avatarHtml}
      <div class="conv-body">
        <div class="conv-top">
          <span class="conv-name">${escHtml(item.name)}</span>
          <span class="conv-time">${timeStr}</span>
        </div>
        <div class="conv-bottom">
          <span class="conv-preview">${escHtml(item.preview)}</span>
          ${item.unread > 0 ? `<span class="conv-badge">${item.unread}</span>` : ''}
        </div>
        ${item.sub ? `<div class="conv-meta">${escHtml(item.sub)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateConvPreview(type, id, content) {
  if (type === 'dm') {
    const c = conversations.find(c => c.id === id);
    if (c) c.last_message = content, c.last_message_at = new Date().toISOString();
  } else {
    const g = groups.find(g => g.id === id);
    if (g) g.last_message = content, g.last_message_at = new Date().toISOString();
  }
}

// ─── Open Chat ────────────────────────────────────────────────────────────
async function openChat(type, id, name, participantId, avatar, sub) {
  activeChat = { type, id, name, participantId, avatar };
  document.querySelector('.app-layout').classList.add('mobile-chat-open');

  // Clear unread
  unreadCounts[`${type === 'dm' ? 'dm' : 'group'}_${id}`] = 0;

  // UI setup
  document.getElementById('welcomeScreen').classList.add('hidden');
  document.getElementById('chatView').classList.remove('hidden');
  document.getElementById('contactsView').classList.add('hidden');
  document.getElementById('dashboardView').classList.add('hidden');

  document.getElementById('chatName').textContent = name;
  const chatAvatar = document.getElementById('chatAvatar');
  if (avatar) { chatAvatar.src = avatar; chatAvatar.style.display = 'block'; }
  else { chatAvatar.style.display = 'none'; }
  document.getElementById('chatSub').textContent = sub || (type === 'dm' ? 'Offline' : '');
  document.getElementById('chatOnlineDot').classList.toggle('hidden', type !== 'dm');

  // Load messages
  const messagesArea = document.getElementById('messagesArea');
  messagesArea.innerHTML = '<div class="typing-indicator hidden" id="typingIndicator"><span></span><span></span><span></span></div>';

  try {
    let msgs = [];
    if (type === 'dm') {
      const res = await fetch(`/api/conversations/${id}/messages`);
      if (res.ok) {
        const data = await res.json();
        msgs = data.messages || data || [];
      }
      // Mark as read
      if (msgs.length > 0) {
        const lastFromOther = [...msgs].reverse().find(m => m.sender_id !== currentUser.id);
        if (lastFromOther) socket.emit('messages:read', { conversationId: id, senderId: lastFromOther.sender_id });
      }
    } else {
      socket.emit('group:join', id);
      const res = await fetch(`/api/groups/${id}/messages`);
      if (res.ok) msgs = await res.json();
    }
    msgs.forEach(m => appendMessage(m, type));
  } catch (e) {
    console.error('Load messages error:', e);
  }

  scrollToBottom();
  renderConversationList();
  document.getElementById('messageInput').focus();
}

// ─── Append Message ────────────────────────────────────────────────────────
function appendMessage(msg, type) {
  const area = document.getElementById('messagesArea');
  const isOut = msg.sender_id === currentUser.id;
  const typing = document.getElementById('typingIndicator');

  const name = msg.sender_display_name || msg.display_name || msg.sender_username || msg.username || 'User';
  const avatar = msg.sender_avatar;
  const time = new Date(msg.created_at);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = `msg-row ${isOut ? 'out' : 'in'}`;

  const avatarHtml = !isOut
    ? `<div class="msg-avatar">${avatar
        ? `<img src="${avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
        : `<div style="width:28px;height:28px;background:var(--primary);border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700">${name[0].toUpperCase()}</div>`
      }</div>`
    : '';

  const senderNameHtml = type === 'group' && !isOut
    ? `<div class="msg-sender">${escHtml(name)}</div>`
    : '';

  div.innerHTML = `
    ${avatarHtml}
    <div class="msg-group">
      ${senderNameHtml}
      <div class="msg-bubble">${escHtml(msg.content)}</div>
      <div class="msg-meta">
        <span class="msg-time">${timeStr}</span>
        ${isOut ? '<span class="msg-status">✓ Delivered</span>' : ''}
      </div>
    </div>`;

  area.insertBefore(div, typing);
  scrollToBottom();
}

function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = area.scrollHeight;
}

// ─── Send Message ──────────────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !activeChat) return;
  input.value = '';

  if (activeChat.type === 'dm') {
    socket.emit('message:send', { conversationId: activeChat.id, content });
  } else {
    socket.emit('group:message', { groupId: activeChat.id, content });
  }

  stopTyping();
}

function setupMessageInput() {
  const input = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');

  btn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  input.addEventListener('input', () => {
    if (!activeChat || !socket) return;
    if (activeChat.type === 'dm' && activeChat.participantId) {
      socket.emit('typing:start', { conversationId: activeChat.id, receiverId: activeChat.participantId });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(stopTyping, 2000);
    } else if (activeChat.type === 'group') {
      socket.emit('group:typing:start', { groupId: activeChat.id });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(stopTyping, 2000);
    }
  });
}

function stopTyping() {
  if (!activeChat || !socket) return;
  if (activeChat.type === 'dm' && activeChat.participantId) {
    socket.emit('typing:stop', { conversationId: activeChat.id, receiverId: activeChat.participantId });
  } else if (activeChat.type === 'group') {
    socket.emit('group:typing:stop', { groupId: activeChat.id });
  }
}

// ─── Navigation ────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;

      const welcomeScreen = document.getElementById('welcomeScreen');
      const chatView = document.getElementById('chatView');
      const contactsView = document.getElementById('contactsView');
      const dashboardView = document.getElementById('dashboardView');

      welcomeScreen.classList.add('hidden');
      chatView.classList.add('hidden');
      contactsView.classList.add('hidden');
      dashboardView.classList.add('hidden');

      if (view === 'chats') {
        // Hide the right panel on mobile so they see the chat list
        document.querySelector('.app-layout').classList.remove('mobile-chat-open');
        if (activeChat) {
          chatView.classList.remove('hidden');
        } else {
          welcomeScreen.classList.remove('hidden');
        }
      } else if (view === 'contacts') {
        contactsView.classList.remove('hidden');
        document.querySelector('.app-layout').classList.add('mobile-chat-open');
        renderContacts();
      } else if (view === 'dashboard') {
        dashboardView.classList.remove('hidden');
        document.querySelector('.app-layout').classList.add('mobile-chat-open');
      }
    });
  });
}

// ─── Contacts / Friends ────────────────────────────────────────────────────
function renderContacts() {
  const friendsListEl = document.getElementById('contactsList');
  const pendingContainer = document.getElementById('pendingRequestsContainer');
  const pendingListEl = document.getElementById('pendingRequestsList');
  const pendingBadge = document.getElementById('pendingBadge');

  // Render pending requests
  if (pendingRequests.length > 0) {
    pendingContainer.classList.remove('hidden');
    pendingBadge.textContent = pendingRequests.length;
    pendingListEl.innerHTML = pendingRequests.map(r => `
      <div class="contact-item">
        <div class="contact-avatar">
          ${r.avatar_url ? `<img src="${r.avatar_url}" style="width:42px;height:42px;border-radius:50%;object-fit:cover">` : (r.display_name || r.username || '?')[0].toUpperCase()}
        </div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(r.display_name || r.username)}</div>
          <div class="contact-handle">@${escHtml(r.username || 'unknown')}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-primary" style="padding: 6px 12px; font-size: 13px;" onclick="acceptFriendRequest(${r.request_id})">Accept</button>
          <button class="btn-secondary" style="padding: 6px 12px; font-size: 13px;" onclick="rejectFriendRequest(${r.request_id})">Reject</button>
        </div>
      </div>
    `).join('');
  } else {
    pendingContainer.classList.add('hidden');
  }

  // Render friends
  if (friends.length === 0) {
    friendsListEl.innerHTML = '<p class="empty-state">You have no friends yet. Add someone above!</p>';
  } else {
    friendsListEl.innerHTML = friends.map(u => `
      <div class="contact-item">
        <div class="contact-avatar">
          ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:42px;height:42px;border-radius:50%;object-fit:cover">` : (u.display_name || u.username || '?')[0].toUpperCase()}
        </div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(u.display_name || u.username)}</div>
          <div class="contact-handle">@${escHtml(u.username || 'unknown')}</div>
        </div>
        <span class="contact-status ${u.is_online ? 'online' : 'offline'}">${u.is_online ? '● Online' : 'Offline'}</span>
        <button class="start-chat-btn" onclick="startDM(${u.id}, '${escHtml(u.display_name || u.username)}', '${escHtml(u.avatar_url || '')}')">Message</button>
      </div>
    `).join('');
  }
}

async function sendFriendRequest() {
  const input = document.getElementById('addFriendInput');
  const btn = document.getElementById('addFriendBtn');
  const status = document.getElementById('addFriendStatus');
  const username = input.value.trim();

  if (!username) return;

  btn.disabled = true;
  btn.textContent = 'Sending...';
  status.textContent = '';

  try {
    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    
    if (res.ok) {
      status.textContent = 'Friend request sent!';
      status.style.color = 'var(--primary)';
      input.value = '';
    } else {
      status.textContent = data.error || 'Failed to send request';
      status.style.color = '#ef4444';
    }
  } catch (e) {
    status.textContent = 'An error occurred';
    status.style.color = '#ef4444';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Request';
  }
}

async function acceptFriendRequest(id) {
  try {
    const res = await fetch(`/api/friends/accept/${id}`, { method: 'PUT' });
    if (res.ok) {
      await loadFriends();
      renderContacts();
      renderConversationList(); // Might need to update badges/online status
    }
  } catch (e) { console.error(e); }
}

async function rejectFriendRequest(id) {
  try {
    const res = await fetch(`/api/friends/reject/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await loadFriends();
      renderContacts();
    }
  } catch (e) { console.error(e); }
}

async function startDM(userId, name, avatar) {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const conv = data.conversation || data;

    await loadConversations();
    renderConversationList();

    // Switch to chats view
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('navChats').classList.add('active');

    openChat('dm', conv.id, name, userId, avatar, null);
  } catch (e) {
    alert('Could not start conversation. Try again.');
  }
}

// ─── Group Modal ───────────────────────────────────────────────────────────
function setupGroupModal() {
  const modal = document.getElementById('groupModal');
  const openBtn = document.getElementById('newGroupBtn');
  const closeBtn = document.getElementById('closeGroupModal');
  const cancelBtn = document.getElementById('cancelGroupModal');
  const createBtn = document.getElementById('createGroupBtn');

  openBtn.addEventListener('click', () => {
    selectedMembers.clear();
    document.getElementById('groupNameInput').value = '';
    renderMembersList();
    modal.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  createBtn.addEventListener('click', createGroup);
}

function renderMembersList() {
  const list = document.getElementById('membersList');
  const others = friends;
  if (others.length === 0) {
    list.innerHTML = '<p class="empty-state-sm">No friends to add yet.</p>';
    return;
  }
  list.innerHTML = others.map(u => {
    const name = u.display_name || u.username;
    const isSelected = selectedMembers.has(u.id);
    return `<div class="member-item ${isSelected ? 'selected' : ''}" onclick="toggleMember(${u.id}, this)">
      <div class="member-check">${isSelected ? '✓' : ''}</div>
      <div class="member-avatar">${u.avatar_url
        ? `<img src="${u.avatar_url}" style="width:32px;height:32px;border-radius:50%;object-fit:cover">`
        : name[0].toUpperCase()
      }</div>
      <span class="member-name">${escHtml(name)}</span>
    </div>`;
  }).join('');
}

function toggleMember(userId, el) {
  if (selectedMembers.has(userId)) {
    selectedMembers.delete(userId);
    el.classList.remove('selected');
    el.querySelector('.member-check').textContent = '';
  } else {
    selectedMembers.add(userId);
    el.classList.add('selected');
    el.querySelector('.member-check').textContent = '✓';
  }
}

async function createGroup() {
  const name = document.getElementById('groupNameInput').value.trim();
  if (!name) { alert('Please enter a group name'); return; }

  const btn = document.getElementById('createGroupBtn');
  btn.textContent = 'Creating...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, memberIds: [...selectedMembers] }),
    });
    if (!res.ok) throw new Error('Failed');
    const group = await res.json();

    document.getElementById('groupModal').classList.add('hidden');
    await loadGroups();
    renderConversationList();

    // Switch to chats + open new group
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('navChats').classList.add('active');
    document.getElementById('welcomeScreen').classList.add('hidden');
    document.getElementById('contactsView').classList.add('hidden');

    openChat('group', group.id, group.name, null, null, `Group · ${group.member_count} members`);
  } catch (e) {
    alert('Failed to create group. Try again.');
  } finally {
    btn.textContent = 'Create Group';
    btn.disabled = false;
  }
}

// ─── Search ────────────────────────────────────────────────────────────────
function setupSearch() {
  document.getElementById('searchInput').addEventListener('input', (e) => {
    renderConversationList(e.target.value);
  });
}

// ─── Online Status ─────────────────────────────────────────────────────────
function updateUserOnline(userId, isOnline) {
  const user = friends.find(u => u.id === parseInt(userId));
  if (user) user.is_online = isOnline;

  if (activeChat?.type === 'dm' && activeChat.participantId === parseInt(userId)) {
    const dot = document.getElementById('chatOnlineDot');
    const sub = document.getElementById('chatSub');
    dot.classList.toggle('hidden', !isOnline);
    sub.textContent = isOnline ? 'Online' : 'Last seen recently';
  }
  renderConversationList();
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m`;
  if (diff < 86400000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ─── Logout ────────────────────────────────────────────────────────────────
async function logout() {
  try {
    const res = await fetch('/auth/logout', { method: 'POST' });
    if (res.ok) {
      window.location.href = '/';
    } else {
      alert('Failed to logout');
    }
  } catch (e) {
    console.error('Logout error:', e);
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────
init();
