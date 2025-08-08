

document.addEventListener("DOMContentLoaded", () => {
  const BACKEND_URL = "https://vibes-fqic.onrender.com";
  // const BACKEND_URL = "http://localhost:3000";

  const albumArt = document.getElementById("album-art");
  const trackTitle = document.getElementById("track-title");
  const trackArtist = document.getElementById("track-artist");
  const elapsedTime = document.getElementById("elapsed-time");
  const remainingTime = document.getElementById("remaining-time");
  const progressFill = document.getElementById("progress-fill");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");
  const reactions = document.querySelectorAll(".reaction-btn");

  const playlistEl = document.getElementById("playlist");
  const playlistSearch = document.getElementById("playlist-search");
  const addTrackUrl = document.getElementById("add-track-url");
  const addTrackBtn = document.getElementById("add-track-btn");

  const chatMessages = document.getElementById("chat-messages");
  const chatText = document.getElementById("chat-text");
  const chatSend = document.getElementById("chat-send");
  const autoscrollToggle = document.getElementById("autoscroll-toggle");

  const toastsRoot = document.getElementById("toasts");
  const leaveRoomBtn = document.getElementById("leave-room-btn");

  let socket = null;
  let roomSlug = null;
  let roomId = null;
  let currentUser = null;
  let isHost = false;
  let playlist = []; 
  let nowPlaying = null; 
  let autoScroll =
    (localStorage.getItem("vibes_autoscroll") || "true") === "true";
  autoscrollToggle.checked = autoScroll;

  function toast(message, { type = "success", timeout = 3500 } = {}) {
    const el = document.createElement("div");
    el.className = `toast ${type === "error" ? "error" : "success"}`;
    el.textContent = message;
    toastsRoot.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, timeout);
  }

  function esc(s) {
    return String(s || "").replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[m])
    );
  }

  (function getSlugFromPath() {
    const m = window.location.pathname.match(/\/room\/(.+)$/);
    if (m) roomSlug = m[1];
  })();

 
  function connectSocket() {
    const token = localStorage.getItem("vibe_token");
    if (!roomSlug) {
      console.error("No room slug found in URL.");
      return;
    }

    socket = io(BACKEND_URL, { auth: { token } });

    socket.on("connect", () => {
      console.log("socket connected");
      socket.emit("joinRoom", roomSlug);
    });

    socket.on("roomNotFound", () => {
      toast("Room not found.", { type: "error" });
      setTimeout(() => (window.location.href = "/"), 1200);
    });

    socket.on("roomState", (state) => {
      if (!state) return;
      roomId = state.id || state.id?.toString?.() || roomId;
      currentUser = state.currentUser;
      isHost = state.isHost;
      playlist =
        (state.playlistState && state.playlistState.playlist) ||
        state.playlist ||
        [];
      nowPlaying = state.nowPlaying;
      renderPlaylist();
      renderNowPlaying(nowPlaying);
      renderChatHistory(state.chatHistory || []);
      renderUserList(state.userList || []);
      toast(`Joined ${state.name || "the room"}`, { timeout: 1800 });
    });

    socket.on("newChatMessage", (msg) => {
      appendChatMessage(msg);
      if (autoScroll) scrollChatToBottom();
    });

    socket.on("updateUserList", (userList) => {
      renderUserList(userList);
    });

    socket.on("playlistUpdated", (plState) => {
      playlist = (plState && plState.playlist) || playlist;
      renderPlaylist();
    });

    socket.on("newSongPlaying", (np) => {
      nowPlaying = np;
      renderNowPlaying(np);
      toast(np ? `Now playing: ${np.track.name}` : "Playback stopped");
    });

    socket.on("suggestionsUpdated", (sugs) => {
     
      if (sugs && sugs.length)
        toast(`New suggestion(s) received`, { timeout: 1200 });
    });

    socket.on("updateListenerCount", (count) => {
    
    });

    socket.on("toast", (data) => {
      if (!data) return;
      toast(data.message || "Notice", {
        type: data.type === "error" ? "error" : "success",
      });
    });

    socket.on("connect_error", (err) => {
      console.warn("Socket error", err);
      toast("Connection error — some features may not work.", {
        type: "error",
        timeout: 3000,
      });
    });

    socket.on("disconnect", () => {
      toast("Disconnected from server", { type: "error", timeout: 1800 });
    });

    socket.on("getHostTimestamp", (data) => {
  
      if (!isHost) return;
     
      const hostPlayerTime = nowPlaying ? Date.now() - nowPlaying.startTime : 0;
      socket.emit("sendHostTimestamp", {
        requesterId: data.requesterId,
        hostPlayerTime,
      });
    });
  }

  function renderNowPlaying(np) {
    if (!np || !np.track) {
      trackTitle.textContent = "No track playing";
      trackArtist.textContent = "";
      progressFill.style.width = "0%";
      elapsedTime.textContent = "0:00";
      remainingTime.textContent = "0:00";
      albumArt.style.background = "linear-gradient(135deg,#334155,#0f1724)";
      return;
    }
    const t = np.track;
    trackTitle.textContent = t.name;
    trackArtist.textContent = t.artist || t.channelTitle || "";

    if (t.albumArt)
      albumArt.style.background = `url('${t.albumArt}') center/cover no-repeat`;
    else
      albumArt.style.background =
        "linear-gradient(135deg,var(--accent), #34d399)";

    function updateProgress() {
      if (!np || !np.track) return;
      const total = np.track.duration_ms || 0;
     
      const position = np.isPlaying
        ? Date.now() - np.startTime
        : np.position || 0;
      const pct = total
        ? Math.min(100, Math.max(0, (position / total) * 100))
        : 0;
      progressFill.style.width = pct + "%";
      elapsedTime.textContent = formatMs(position);
      remainingTime.textContent = formatMs(Math.max(0, total - position));
    }
  
    updateProgress();
    if (renderNowPlaying._interval) clearInterval(renderNowPlaying._interval);
    renderNowPlaying._interval = setInterval(updateProgress, 800);
  }

  function renderPlaylist(filterText = "") {
    playlistEl.innerHTML = "";
    const list =
      (filterText
        ? playlist.filter(
            (t) =>
              (t.name || "").toLowerCase().includes(filterText) ||
              (t.artist || "").toLowerCase().includes(filterText)
          )
        : playlist) || [];
    list.forEach((track, idx) => {
      const li = document.createElement("li");
      li.className = "playlist-item";
      li.draggable = true;
      li.dataset.index = idx;
      li.innerHTML = `
        <div class="playlist-thumb" style="background-image: url('${
          track.albumArt || "/placeholder.svg"
        }'); background-size:cover; background-position:center"></div>
        <div class="playlist-meta">
          <div class="track-name">${esc(track.name)}</div>
          <div class="track-sub">${esc(
            track.artist || track.source || ""
          )}</div>
        </div>
        <div class="playlist-actions">
          ${
            nowPlaying &&
            nowPlaying.track &&
            nowPlaying.track.videoId === track.videoId
              ? `<span class="now-playing-badge">NOW</span>`
              : ""
          }
          <button class="btn small play-btn" title="Play">▶</button>
          ${
            isHost
              ? `<button class="btn small delete-btn" title="Delete">🗑</button>`
              : ""
          }
        </div>
      `;

      li.querySelector(".play-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!socket) return;
    
        const originalIndex = playlist.findIndex(
          (p) => p.videoId === track.videoId
        );
        if (originalIndex !== -1)
          socket.emit("playTrackAtIndex", {
            roomId: roomId,
            index: originalIndex,
          });
      });
 
      li.addEventListener("dblclick", () => {
        const originalIndex = playlist.findIndex(
          (p) => p.videoId === track.videoId
        );
        if (originalIndex !== -1 && socket)
          socket.emit("playTrackAtIndex", {
            roomId: roomId,
            index: originalIndex,
          });
      });


      if (isHost) {
        const delBtn = li.querySelector(".delete-btn");
        delBtn &&
          delBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const originalIndex = playlist.findIndex(
              (p) => p.videoId === track.videoId
            );
            if (originalIndex !== -1 && socket) {
              if (!confirm("Delete this track from playlist?")) return;
              socket.emit("deleteTrack", {
                roomId: roomId,
                indexToDelete: originalIndex,
              });
            }
          });
      }

 
      li.addEventListener("dragstart", (ev) => {
        li.classList.add("dragging");
        ev.dataTransfer.setData("text/plain", track.videoId);
        ev.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
      });

    
      playlistEl.appendChild(li);
    });
  }

  playlistEl.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    const afterEl = getDragAfterElement(playlistEl, ev.clientY);
    const dragging = document.querySelector(".playlist-item.dragging");
    if (!dragging) return;
    if (!afterEl) playlistEl.appendChild(dragging);
    else playlistEl.insertBefore(dragging, afterEl);
  });

  playlistEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const dragging = document.querySelector(".playlist-item.dragging");
    if (!dragging) return;
    dragging.classList.remove("dragging");
  
    const newOrderVideoIds = Array.from(playlistEl.children)
      .map((li) => {
        const idx = li.dataset.index;
      
        const name = li.querySelector(".track-name").textContent;
        return playlist.find((p) => p.name === name || p.videoId === p.videoId)
          ?.videoId;
      })
      .filter(Boolean);


    const newPlaylist = [];
    newOrderVideoIds.forEach((vid) => {
      const t = playlist.find((p) => p.videoId === vid);
      if (t) newPlaylist.push(t);
    });
    // if lengths mismatch (e.g., filtered view), fall back to DOM order + remaining
    if (newPlaylist.length !== playlist.length) {
      // create mapping by name fallback (best-effort)
      const domNames = Array.from(playlistEl.children).map(
        (li) => li.querySelector(".track-name").textContent
      );
      const byName = domNames
        .map((n) => playlist.find((p) => p.name === n) || null)
        .filter(Boolean);
      if (byName.length === playlist.length) {
        playlist = byName;
      } else {
        // as last resort, keep existing order
        // (do not overwrite)
      }
    } else {
      playlist = newPlaylist;
    }

    renderPlaylist(playlistSearch.value.trim().toLowerCase());

    // emit reorder — custom event; server must implement to persist this change across clients
    if (socket) {
      const reorderPayload = playlist.map((t) => t.videoId);
      socket.emit("reorderPlaylist", { roomId: roomId, order: reorderPayload });
      toast("Playlist reordered", { timeout: 1200 });
    }
  });

  function getDragAfterElement(container, y) {
    const draggableEls = [
      ...container.querySelectorAll(".playlist-item:not(.dragging)"),
    ];
    return draggableEls.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset: offset, element: child };
        } else {
          return closest;
        }
      },
      { offset: Number.NEGATIVE_INFINITY }
    ).element;
  }

  // playlist search
  playlistSearch &&
    playlistSearch.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      renderPlaylist(q);
    });

  // add track
  addTrackBtn &&
    addTrackBtn.addEventListener("click", () => {
      const url = (addTrackUrl.value || "").trim();
      if (!url)
        return toast("Paste a YouTube video or playlist URL", {
          type: "error",
        });
      if (!socket) return toast("Not connected", { type: "error" });
      socket.emit("addYouTubeTrack", { roomId: roomId, url });
      addTrackUrl.value = "";
      toast("Adding track...", { timeout: 1500 });
    });

  // allow paste detection
  addTrackUrl &&
    addTrackUrl.addEventListener("paste", (e) => {
      setTimeout(() => {
        const v = addTrackUrl.value.trim();
        if (v) addTrackBtn.click();
      }, 40);
    });

  // playback controls (host-only)
  playPauseBtn.addEventListener("click", () => {
    if (!socket) return;
    if (!isHost) {
      toast("Only the host can control playback", { type: "error" });
      return;
    }
    // toggle: emit hostPlaybackChange
    const currentlyPlaying = nowPlaying;
    if (!currentlyPlaying) return;
    const willPlay = !currentlyPlaying.isPlaying;
    const position = currentlyPlaying.position || 0;
    socket.emit("hostPlaybackChange", {
      roomId: roomId,
      isPlaying: willPlay,
      position,
    });
  });

  prevBtn.addEventListener("click", () => {
    if (!socket) return;
    if (!isHost)
      return toast("Only the host can control playback", { type: "error" });
    socket.emit("playPrevTrack", { roomId: roomId });
  });
  nextBtn.addEventListener("click", () => {
    if (!socket) return;
    if (!isHost)
      return toast("Only the host can control playback", { type: "error" });
    socket.emit("skipTrack", { roomId: roomId });
  });

  // reactions
  reactions.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!socket) return;
      // send reaction as chat message (simple approach; server doesn't have reaction event)
      const emoji = btn.textContent || "👍";
      socket.emit("sendMessage", { roomId: roomId, text: emoji });
    });
  });

  // chat send
  chatSend.addEventListener("click", sendChat);
  chatText.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  function sendChat() {
    const text = (chatText.value || "").trim();
    if (!text) return;
    if (!socket) return toast("Not connected", { type: "error" });
    socket.emit("sendMessage", { roomId: roomId, text });
    chatText.value = "";
  }

  function appendChatMessage(msg) {
    if (!msg) return;
    const el = document.createElement("div");
    if (msg.system) {
      el.className = "chat-system";
      el.textContent = msg.text;
    } else {
      el.className = "chat-msg";
      const avatar = document.createElement("div");
      avatar.className = "chat-avatar";
      if (msg.avatar)
        (avatar.style.backgroundImage = `url('${msg.avatar}')`),
          (avatar.style.backgroundSize = "cover");
      const body = document.createElement("div");
      body.className = "chat-body";
      const userEl = document.createElement("div");
      userEl.className = "chat-user";
      userEl.textContent = msg.user || msg.userId || "Anon";
      userEl.addEventListener("click", () => {
        // prefill @mention
        chatText.value = `@${userEl.textContent} `;
        chatText.focus();
      });
      const textEl = document.createElement("div");
      textEl.className = "chat-text";
      textEl.innerHTML = esc(msg.text);
      const ts = document.createElement("div");
      ts.className = "chat-ts";
      ts.textContent = msg.timestamp || "";
      body.appendChild(userEl);
      body.appendChild(textEl);
      body.appendChild(ts);
      el.appendChild(avatar);
      el.appendChild(body);
    }
    chatMessages.appendChild(el);
  }

  function renderChatHistory(history = []) {
    chatMessages.innerHTML = "";
    (history || []).forEach((m) => appendChatMessage(m));
    if (autoScroll) scrollChatToBottom();
  }

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight + 200;
  }

  function renderUserList(users) {
    // optional: you could show small presence list; we'll toast join/leave messages
    // detect join/leave by comparing to previous list (not implemented here)
  }

  // utility: format ms to m:ss
  function formatMs(ms) {
    if (!ms || isNaN(ms)) return "0:00";
    ms = Math.max(0, Math.floor(ms));
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  // autoscroll toggle persistence
  autoscrollToggle.addEventListener("change", (e) => {
    autoScroll = !!e.target.checked;
    localStorage.setItem("vibes_autoscroll", autoScroll ? "true" : "false");
  });

  // leave room
  leaveRoomBtn &&
    leaveRoomBtn.addEventListener("click", () => {
      if (confirm("Leave this room?")) {
        // inform server (processUserLeave is handled on disconnect)
        if (socket) socket.disconnect();
        window.location.href = "/";
      }
    });

  // initial connect
  connectSocket();

  // clean up when leaving page
  window.addEventListener("beforeunload", () => {
    if (socket) socket.disconnect();
  });
});
