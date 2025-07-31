// server.js (Final Production-Ready Version - Corrected)
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const ytDlpExec = require("yt-dlp-exec");

// --- UNCHANGED: INITIAL SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 4000;
const RECONNECTION_GRACE_PERIOD = 10 * 1000;
const CACHE_DURATION = 15 * 60 * 1000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let rooms = {}; // This is our "Hot Cache" for live data
let userSockets = {};
const searchCache = new Map();
const reconnectionTimers = {};

// --- UNCHANGED: MIDDLEWARE & PASSPORT AUTH ---
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => done(null, profile)
  )
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));
app.use(express.static(path.join(__dirname, "../frontend/public")));

// --- UNCHANGED: AUTH GATES & BASIC ROUTES ---
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect("/");
};
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);
app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect("/");
  });
});
app.get("/api/user", (req, res) => {
  if (req.isAuthenticated()) res.json(req.user);
  else res.status(401).json({ message: "Not authenticated" });
});

// --- MODIFIED: /room/:roomId IS NOW RESILIENT ---
app.get("/room/:roomSlug", ensureAuthenticated, async (req, res) => {
    const { roomSlug } = req.params;
    
    // Check memory first if a room with this slug is already active
    const activeRoom = Object.values(rooms).find(r => r.slug === roomSlug);
    if (activeRoom) {
        return res.sendFile(path.join(__dirname, "../frontend/views", "room.html"));
    }

    // If not in memory, check the database
    const { data } = await supabase.from('rooms').select('id').eq('slug', roomSlug).single();
    if (data) {
        return res.sendFile(path.join(__dirname, "../frontend/views", "room.html"));
    }

    // Not found in either
    res.status(404).sendFile(path.join(__dirname, "../frontend/views", "404.html"));
});

// --- UNCHANGED: CATCH-ALL ROUTE ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/views", "index.html"));
});

// --- UNCHANGED: SOCKET.IO MIDDLEWARE ---
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());
io.use((socket, next) => {
  const user = socket.request.user;
  if (user) {
    socket.user = user;
    next();
  } else {
    next(new Error("unauthorized"));
  }
});

// --- UNCHANGED: MAIN SOCKET CONNECTION HANDLER ---
io.on("connection", (socket) => {
  socket.on("getRooms", () => broadcastLobbyData());
  socket.on("createRoom", (roomData) => handleCreateRoom(socket, roomData));
  socket.on("joinRoom", (roomId) => handleJoinRoom(socket, roomId));
  socket.on("leaveRoom", ({ roomId }) => processUserLeave(socket, roomId));
  socket.on("disconnect", () => handleLeaveRoom(socket));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
  socket.on("hostPlaybackChange", (data) =>
    handleHostPlaybackChange(socket, data)
  );
  socket.on("addYouTubeTrack", ({ roomId, url }) =>
    handleAddYouTubeTrack(socket, roomId, url)
  );
  socket.on("approveSuggestion", (data) =>
    handleApproveSuggestion(socket, data)
  );
  socket.on("rejectSuggestion", (data) => handleRejectSuggestion(socket, data));
  socket.on("skipTrack", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playNextSong(data.roomId);
  });
  socket.on("playPrevTrack", (data) => {
    if (rooms[data.roomId] && rooms[data.roomId].nowPlayingIndex > 0)
      playPrevSong(data.roomId);
  });
  socket.on("playTrackAtIndex", (data) => {
    if (rooms[data.roomId] && socket.user.id === rooms[data.roomId].hostUserId)
      playTrackAtIndex(data.roomId, data.index);
  });
  socket.on("deleteTrack", (data) => handleDeleteTrack(socket, data));
  socket.on("searchYouTube", (data) => handleSearchYouTube(socket, data));
});

// --- HANDLER FUNCTIONS ---

const generateUserList = (room) => {
  if (!room) return [];
  return Object.values(room.listeners).map((listener) => ({
    id: listener.user.id,
    displayName: listener.user.displayName,
    avatar: listener.user.photos[0].value,
    isHost: listener.user.id === room.hostUserId,
  }));
};

const getSanitizedRoomState = (room, isHost, user) => {
  if (!room) return null;
  const userList = generateUserList(room);
  const {
    songEndTimer,
    deletionTimer,
    syncInterval,
    listeners,
    ...safeRoomState
  } = room;
  safeRoomState.listenerCount = userList.length;
  safeRoomState.isHost = isHost;
  safeRoomState.currentUser = {
    name: user.displayName,
    id: user.id,
    avatar: user.photos[0].value,
  };
  safeRoomState.nowPlaying = getAuthoritativeNowPlaying(room);
  safeRoomState.playlistState = getSanitizedPlaylist(room);
  safeRoomState.suggestions = room.suggestions;
  safeRoomState.isPlaying = room.isPlaying;
  safeRoomState.userList = userList;
  return safeRoomState;
};

// --- MODIFIED: LOBBY DATA NOW COMES FROM DB FOR RESILIENCE ---
async function broadcastLobbyData() {
    const { data: roomsFromDb, error: roomsError } = await supabase.rpc('get_lobby_rooms_with_art');
    const { data: vibes, error: vibesError } = await supabase.rpc('get_live_vibe_counts');

    if (roomsError || vibesError) {
        console.error("Error fetching lobby data:", roomsError || vibesError);
        return;
    }

    const mergedRooms = roomsFromDb.map(dbRoom => ({
        id: dbRoom.id,
        slug: dbRoom.slug, // Pass the slug through to the client
        name: dbRoom.name,
        listenerCount: rooms[dbRoom.id] ? Object.keys(rooms[dbRoom.id].listeners).length : 0,
        nowPlaying: dbRoom.album_art_url ? { track: { albumArt: dbRoom.album_art_url } } : null,
        vibe: { name: dbRoom.vibe_name, type: dbRoom.vibe_type }
    }));

    io.emit("updateLobby", { rooms: mergedRooms, vibes: vibes || [] });
}

// --- MODIFIED: handleJoinRoom is the "Hydration" point ---
// In backend/server.js

// In backend/server.js

// In backend/server.js

async function handleJoinRoom(socket, roomSlug) {
    const user = socket.user;
    
    // --- STEP 1: FORCE LEAVE FROM ALL PREVIOUS ROOMS ---
    // Socket.IO keeps a Set of rooms the socket is in. The first one is always its own ID.
    const currentSocketRooms = Array.from(socket.rooms);
    for (const oldRoomId of currentSocketRooms) {
        // We iterate through every room this socket is subscribed to.
        // We skip leaving the room that is the socket's own personal ID.
        if (oldRoomId !== socket.id) {
            console.log(`User ${user.displayName} is currently in room ${oldRoomId}. Forcing leave.`);
            // Use Socket.IO's native leave method.
            socket.leave(oldRoomId);
            // Run our master cleanup logic for the old room.
            await processUserLeave(socket, oldRoomId);
        }
    }
    
    // --- STEP 2: PROCEED WITH JOINING THE NEW ROOM ---
    const { data: newRoomData } = await supabase.from('rooms').select('id, slug').eq('slug', roomSlug).single();
    if (!newRoomData) {
        return socket.emit('roomNotFound');
    }
    
    const roomIdToJoin = newRoomData.id.toString();
    let room = rooms[roomIdToJoin];

    if (!room) {
        // Hydration logic (unchanged)
        const { data: roomData, error: roomError } = await supabase.from('rooms').select('*, vibes(*)').eq('id', roomIdToJoin).single();
        if (roomError || !roomData) return socket.emit('roomNotFound');
        const { data: dbTracks } = await supabase.from('playlist_tracks').select('*').eq('room_id', roomIdToJoin).order('position_in_queue');
        const completePlaylist = (dbTracks || []).map(track => ({ ...track, url: `https://www.youtube.com/watch?v=${track.video_id}` }));
        
        rooms[roomIdToJoin] = {
            id: roomIdToJoin, slug: roomData.slug, name: roomData.name, vibe: roomData.vibes,
            hostUserId: roomData.host_user_id, nowPlayingIndex: roomData.now_playing_index,
            playlist: completePlaylist, listeners: {}, suggestions: [],
            nowPlaying: null, songEndTimer: null, deletionTimer: null, isPlaying: false,
        };
        room = rooms[roomIdToJoin];
    }
    
    // The rest of the join logic is now safe to execute
    const isReconnecting = !!reconnectionTimers[user.id];
    if (isReconnecting) {
        clearTimeout(reconnectionTimers[user.id]);
        delete reconnectionTimers[user.id];
    }
    if (room.deletionTimer) {
        clearTimeout(room.deletionTimer);
        room.deletionTimer = null;
    }

    socket.join(roomIdToJoin); // Natively join the new room
    room.listeners[user.id] = { socketId: socket.id, user: user };
    userSockets[socket.id] = { user: user, roomId: roomIdToJoin };

    let isNewHost = false;
    if (Object.keys(room.listeners).length === 1 && room.hostUserId !== user.id) {
        room.hostUserId = user.id;
        isNewHost = true;
        await supabase.from("rooms").update({ host_user_id: user.id }).eq("id", roomIdToJoin);
    }

    const isHost = room.hostUserId === user.id;

    if (room.nowPlayingIndex !== -1 && !room.nowPlaying && room.playlist.length > 0) {
        playTrackAtIndex(roomIdToJoin, room.nowPlayingIndex, false);
    }
    
    socket.emit("roomState", getSanitizedRoomState(room, isHost, user));
    if (isNewHost) socket.emit("newChatMessage", { system: true, text: "👑 You are now the host of this room!" });
    if (room.nowPlaying) socket.emit("newSongPlaying", getAuthoritativeNowPlaying(room));

    if (!isReconnecting) {
        io.to(roomIdToJoin).emit("newChatMessage", { system: true, text: `${user.displayName} has joined the vibe.` });
        const userList = generateUserList(room);
        io.to(roomIdToJoin).emit("updateUserList", userList);
        io.to(roomIdToJoin).emit("updateListenerCount", userList.length);
        broadcastLobbyData();
    } else {
        io.to(roomIdToJoin).emit("updateUserList", generateUserList(room));
    }
}

// --- UNCHANGED: Core Room Lifecycle Logic ---
async function processUserLeave(socket, roomId) {
  const room = rooms[roomId];
  if (!room || !socket.user || !room.listeners[socket.user.id]) return;
  const user = socket.user;
  const wasHost = room.hostUserId === user.id;
  delete room.listeners[user.id];
  delete userSockets[socket.id];
  io.to(roomId).emit("newChatMessage", {
    system: true,
    text: `${user.displayName} has left the vibe.`,
  });
  const remainingListeners = Object.values(room.listeners);
  if (wasHost && remainingListeners.length > 0) {
    const newHost = remainingListeners[0];
    room.hostUserId = newHost.user.id;
    await supabase
      .from("rooms")
      .update({ host_user_id: newHost.user.id })
      .eq("id", roomId);
    const newHostSocket = io.sockets.sockets.get(newHost.socketId);
    if (newHostSocket) {
      newHostSocket.emit("hostAssigned");
      newHostSocket.emit("newChatMessage", {
        system: true,
        text: "👑 You are now the host of this room!",
      });
      newHostSocket.broadcast
        .to(roomId)
        .emit("newChatMessage", {
          system: true,
          text: `👑 ${newHost.user.displayName} is now the host.`,
        });
    }
  }
  const updatedUserList = generateUserList(room);
  io.to(roomId).emit("updateUserList", updatedUserList);
  io.to(roomId).emit("updateListenerCount", updatedUserList.length);
  if (remainingListeners.length === 0) {
    room.deletionTimer = setTimeout(async () => {
      if (rooms[roomId] && Object.keys(rooms[roomId].listeners).length === 0) {
        if (room.songEndTimer) clearTimeout(room.songEndTimer);
        if (room.syncInterval) clearInterval(room.syncInterval);
        await supabase.from("rooms").delete().eq("id", roomId);
        delete rooms[roomId];
        broadcastLobbyData();
      }
    }, 30 * 1000);
  }
  broadcastLobbyData();
}

// In backend/server.js

// In backend/server.js

function handleLeaveRoom(socket) {
    const userSocketInfo = userSockets[socket.id];
    if (!userSocketInfo) return;

    const { user, roomId } = userSocketInfo;
    
    // This function now ONLY starts the timer. It does NOT pause or alter the
    // room's playback state in any way. The "radio station" keeps playing.
    reconnectionTimers[user.id] = setTimeout(() => {
        // This code runs only if the user does NOT reconnect in time.
        console.log(`Grace period expired for ${user.displayName}. Processing full leave.`);
        processUserLeave(socket, roomId); // The original, correct cleanup logic
        delete reconnectionTimers[user.id];
    }, RECONNECTION_GRACE_PERIOD);
}

// --- MODIFIED: Music Handlers Now Interact with DB ---
// In backend/server.js

async function getPlayableUrl(videoId) {
  if (!videoId) return null;
  try {
    // The '-g' flag is crucial: it tells yt-dlp to just get the URL and exit, which is extremely fast.
    // '-f bestaudio' ensures we only get the audio stream.
    const playableUrl = await ytDlpExec(`https://www.youtube.com/watch?v=${videoId}`, {
      g: true,
      f: 'bestaudio',
    });
    // yt-dlp-exec returns the URL with a newline character at the end, so we trim it.
    return playableUrl.trim();
  } catch (error) {
    console.error(`Failed to get playable URL for videoId ${videoId}:`, error.message);
    return null;
  }
}

async function handleAddYouTubeTrack(socket, roomId, url) {
    const room = rooms[roomId];
    if (!room) return;
    const isHost = socket.user.id === room.hostUserId;

    try {
        // This is the ONE and ONLY slow, full metadata fetch.
        // We use `-f bestaudio` to ensure `info.url` is a direct audio stream.
        const fullInfo = await ytDlpExec(url, { dumpSingleJson: true, format: "bestaudio" });
        
        let tracksToProcess = fullInfo.entries ? fullInfo.entries : [fullInfo];

        const completeTrackObjects = tracksToProcess.filter(info => info && info.id).map(info => ({
            videoId: info.id,
            name: info.title,
            artist: info.uploader || info.channel,
            albumArt: info.thumbnails?.pop()?.url || "/assets/placeholder.svg",
            duration_ms: info.duration * 1000,
            url: info.url, // This is now the DIRECT, PLAYABLE audio stream URL.
        }));

        if (isHost) {
            const currentPlaylistSize = room.playlist.length;
            const tracksForDb = completeTrackObjects.map((track, index) => ({
                room_id: roomId, added_by_user_id: socket.user.id, video_id: track.videoId,
                name: track.name, artist: track.artist, album_art_url: track.albumArt,
                duration_ms: track.duration_ms, position_in_queue: currentPlaylistSize + index,
            }));

            const { data: newDbTracks, error } = await supabase.from('playlist_tracks').insert(tracksForDb).select();
            if (error) throw error;
            
            const finalTracks = newDbTracks.map((dbTrack, index) => ({ ...completeTrackObjects[index], ...dbTrack }));
            room.playlist.push(...finalTracks);

            if (room.nowPlayingIndex === -1 && room.playlist.length > 0) {
                playTrackAtIndex(roomId, 0);
            } else {
                io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
            }
        } else {
            const suggestions = completeTrackObjects.map((track) => ({ 
                ...track, 
                suggestionId: `sugg_${Date.now()}_${Math.random()}`,
                suggester: { id: socket.user.id, name: socket.user.displayName }
            }));
            room.suggestions.push(...suggestions);
            io.to(roomId).emit("suggestionsUpdated", room.suggestions);
        }
    } catch (e) {
        console.error("yt-dlp error or DB error:", e);
        socket.emit("newChatMessage", { system: true, text: "Sorry, that link could not be processed." });
    }
}

async function handleDeleteTrack(socket, { roomId, indexToDelete }) {
    const room = rooms[roomId];
    if (!room || socket.user.id !== room.hostUserId || indexToDelete < 0 || indexToDelete >= room.playlist.length) {
        return;
    }
    
    const isDeletingCurrent = room.nowPlayingIndex === indexToDelete;
    const trackToRemove = room.playlist[indexToDelete];
    
    // Modify the in-memory playlist first
    room.playlist.splice(indexToDelete, 1);
    
    // Now, handle the database and state logic
    if (trackToRemove && trackToRemove.id) {
        await supabase.from('playlist_tracks').delete().eq('id', trackToRemove.id);
    }
    
    if (indexToDelete < room.nowPlayingIndex) {
        room.nowPlayingIndex--;
    }
    
    // Re-number remaining tracks' positions in the DB
    for (let i = 0; i < room.playlist.length; i++) {
        if (room.playlist[i].position_in_queue !== i) {
            room.playlist[i].position_in_queue = i;
            if(room.playlist[i].id) {
                await supabase.from('playlist_tracks').update({ position_in_queue: i }).eq('id', room.playlist[i].id);
            }
        }
    }
    
    // --- THE GHOST TRACK FIX ---
    if (isDeletingCurrent) {
        // If we deleted the current song, we must decide what to do next.
        if (room.playlist.length > 0) {
            // If there are more songs, play the next one at the current index.
            // Note: We don't increment the index, as the next song has shifted into its place.
            playTrackAtIndex(roomId, room.nowPlayingIndex);
        } else {
            // If the playlist is now EMPTY, forcefully stop everything.
            if (room.songEndTimer) clearTimeout(room.songEndTimer);
            if (room.syncInterval) clearInterval(room.syncInterval);
            room.nowPlaying = null;
            room.isPlaying = false;
            room.nowPlayingIndex = -1;
            
            // Update the DB to reflect the stopped state
            await supabase.from('rooms').update({ now_playing_index: -1 }).eq('id', roomId);
            
            // Tell all clients that playback has stopped
            io.to(roomId).emit("newSongPlaying", null);
            io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
            broadcastLobbyData();
        }
    } else {
        // If we just deleted a song from the queue that wasn't playing, just update the playlist.
        await supabase.from('rooms').update({ now_playing_index: room.nowPlayingIndex }).eq('id', roomId);
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
    }
}

// Replace your entire existing playTrackAtIndex function with this one.

// In backend/server.js

async function playTrackAtIndex(roomId, index, shouldBroadcast = true) {
    const room = rooms[roomId];
    if (!room) return;
    
    if (index < 0 || index >= room.playlist.length) {
        // Stop playback logic (unchanged and correct)
        return;
    }
    
    let track = room.playlist[index];
    if (!track) return;

    // --- RESILIENCE FIX ---
    // If the track is missing a URL (meaning it was just hydrated from DB after a restart),
    // we do a one-time, fast fetch to get a fresh URL.
    if (!track.url) {
        const playableUrl = await getPlayableUrl(track.video_id);
        if (!playableUrl) {
            io.to(roomId).emit("newChatMessage", { system: true, text: `Skipping "${track.name}" (unavailable).` });
            return playNextSong(roomId);
        }
        // Update the in-memory object with the fresh URL for next time.
        track.url = playableUrl;
    }
    // --- END OF FIX ---

    // Now, we are guaranteed to have a playable track object.
    room.nowPlayingIndex = index;
    await supabase.from('rooms').update({ now_playing_index: index }).eq('id', roomId);

    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);
    
    room.nowPlaying = { track: track, startTime: Date.now(), position: 0 };
    room.isPlaying = true;

    if (shouldBroadcast) {
        io.to(roomId).emit("newSongPlaying", getAuthoritativeNowPlaying(room));
        broadcastLobbyData();
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
    }
    
    room.songEndTimer = setTimeout(() => playNextSong(roomId), track.duration_ms + 1500);
    room.syncInterval = setInterval(() => { if (room.isPlaying) io.to(roomId).emit("syncPulse", getAuthoritativeNowPlaying(room)); }, SYNC_INTERVAL);
}


// --- UNCHANGED: All remaining helper functions ---

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')       // Replace spaces with -
    .replace(/[^\w\-]+/g, '')   // Remove all non-word chars
    .replace(/\-\-+/g, '-')     // Replace multiple - with single -
    .replace(/^-+/, '')         // Trim - from start of text
    .replace(/-+$/, '');        // Trim - from end of text
}
async function handleCreateRoom(socket, roomData) {
    const { roomName, vibe } = roomData;
    if (!roomName || !vibe || !vibe.name || !vibe.type) {
        return socket.emit("error", { message: "Invalid room data provided." });
    }

    try {
        const vibeId = await findOrCreateVibe(vibe);
        if (!vibeId) return socket.emit("error", { message: "Could not process vibe." });

        // --- NEW SLUG LOGIC ---
        let baseSlug = slugify(roomName);
        let finalSlug = baseSlug;
        let isUnique = false;
        let attempts = 0;

        // Keep trying new slugs until we find a unique one
        while (!isUnique && attempts < 10) {
            const { data, error } = await supabase.from('rooms').select('id').eq('slug', finalSlug).single();
            if (!data) { // If no room is found with this slug, it's unique
                isUnique = true;
            } else {
                // If the slug is taken, add a random suffix and try again
                finalSlug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
            }
            attempts++;
        }

        if (!isUnique) {
            return socket.emit("error", { message: "Could not create a unique room link. Please try a different name." });
        }
        // --- END OF NEW SLUG LOGIC ---

        const { data: newRoom, error: roomError } = await supabase.from("rooms")
            .insert({ 
                name: roomName, 
                host_user_id: socket.user.id, 
                vibe_id: vibeId, 
                now_playing_index: -1,
                slug: finalSlug // Save the unique slug
            })
            .select("id, slug") // We now need both the id and the slug back
            .single();

        if (roomError) {
            console.error("Error creating room in DB:", roomError);
            return socket.emit("error", { message: "Failed to create room." });
        }

        const roomId = newRoom.id.toString();
        rooms[roomId] = {
            id: roomId, slug: newRoom.slug, name: roomName, vibe: vibe, hostUserId: socket.user.id, listeners: {},
            playlist: [], nowPlayingIndex: -1, suggestions: [], nowPlaying: null,
            songEndTimer: null, deletionTimer: null, isPlaying: false,
        };

        // Send back BOTH the ID and the SLUG
        socket.emit("roomCreated", { roomId, slug: newRoom.slug });
        broadcastLobbyData();
    } catch (error) {
        console.error("An unexpected error occurred in handleCreateRoom:", error);
        socket.emit("error", { message: "An internal server error occurred." });
    }
}

async function findOrCreateVibe(vibeData) {
  let { data: existingVibe, error: findError } = await supabase
    .from("vibes")
    .select("id")
    .eq("name", vibeData.name)
    .single();
  if (findError && findError.code !== "PGRST116") {
    console.error("Error finding vibe:", findError);
    return null;
  }
  if (existingVibe) return existingVibe.id;
  if (vibeData.type === "CUSTOM") {
    let { data: newVibe, error: createError } = await supabase
      .from("vibes")
      .insert({ name: vibeData.name, type: "CUSTOM" })
      .select("id")
      .single();
    if (createError) {
      console.error("Error creating custom vibe:", createError);
      return null;
    }
    return newVibe.id;
  }
  return null;
}
async function handleSearchYouTube(socket, { query }) {
  if (!query) return;
  const normalizedQuery = query.trim().toLowerCase();
  if (
    searchCache.has(normalizedQuery) &&
    Date.now() - searchCache.get(normalizedQuery).timestamp < CACHE_DURATION
  ) {
    return socket.emit(
      "searchYouTubeResults",
      searchCache.get(normalizedQuery).results
    );
  }
  try {
    const searchResults = await ytDlpExec(`ytsearch10:"${normalizedQuery}"`, {
      dumpSingleJson: true,
      flatPlaylist: true,
    });
    const videoResults = searchResults.entries
      .filter((info) => info)
      .map((info) => ({
        videoId: info.id,
        title: info.title,
        artist: info.uploader || info.channel,
        thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      }));
    searchCache.set(normalizedQuery, {
      results: videoResults,
      timestamp: Date.now(),
    });
    socket.emit("searchYouTubeResults", videoResults);
  } catch (error) {
    console.error(`yt-dlp search error for query "${normalizedQuery}":`, error);
    socket.emit("searchYouTubeResults", []);
  }
}
function playNextSong(roomId) {
    const room = rooms[roomId];
    // Guard clause: Do nothing if the room doesn't exist or the playlist is empty.
    if (!room || room.playlist.length === 0) {
        return;
    }

    // Calculate the next index.
    let nextIndex = room.nowPlayingIndex + 1;

    // --- THE LOOPING LOGIC ---
    // If the next index is past the end of the playlist, loop back to the start.
    if (nextIndex >= room.playlist.length) {
        console.log(`Playlist ended in room ${roomId}. Looping back to start.`);
        nextIndex = 0;
    }

    playTrackAtIndex(roomId, nextIndex);
}
function playPrevSong(roomId) {
  const room = rooms[roomId];
  if (room) playTrackAtIndex(roomId, room.nowPlayingIndex - 1);
}
const getAuthoritativeNowPlaying = (room) => {
  if (!room || !room.nowPlaying) return null;
  const authoritativeState = {
    ...room.nowPlaying,
    isPlaying: room.isPlaying,
    serverTimestamp: Date.now(),
    nowPlayingIndex: room.nowPlayingIndex,
  };
  if (room.isPlaying) {
    authoritativeState.position = Date.now() - authoritativeState.startTime;
  }
  return authoritativeState;
};
// In backend/server.js

async function handleApproveSuggestion(socket, { roomId, suggestionId }) {
    const room = rooms[roomId];
    if (!room || socket.user.id !== room.hostUserId) return;

    const suggestionIndex = room.suggestions.findIndex((s) => s.suggestionId === suggestionId);
    if (suggestionIndex === -1) return;

    const [approvedSuggestion] = room.suggestions.splice(suggestionIndex, 1);
    const { suggestionId: sid, suggester, ...trackData } = approvedSuggestion;
    
    const currentPlaylistSize = room.playlist.length;
    
    // --- THE FIX ---
    // 1. We remove the `.single()` which was causing the crash.
    //    `insert()` will now reliably return an array of the inserted rows.
    const { data: newDbTracks, error } = await supabase.from('playlist_tracks').insert({
        room_id: roomId,
        added_by_user_id: suggester.id,
        video_id: trackData.videoId,
        name: trackData.name,
        artist: trackData.artist,
        album_art_url: trackData.albumArt,
        duration_ms: trackData.duration_ms,
        position_in_queue: currentPlaylistSize,
    }).select(); // We get back an array, e.g., [{...}]

    // 2. We add error handling and safely get the first (and only) item from the array.
    if (error || !newDbTracks || newDbTracks.length === 0) {
        console.error("Error saving approved suggestion to DB:", error);
        // Put the suggestion back in the list if the database save fails.
        room.suggestions.splice(suggestionIndex, 0, approvedSuggestion);
        return; // Stop execution
    }
    const newDbTrack = newDbTracks[0];
    // --- END OF FIX ---

    // Now we can safely proceed.
    room.playlist.push({ ...trackData, ...newDbTrack });

    io.to(roomId).emit("suggestionsUpdated", room.suggestions);
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));

    if (room.nowPlayingIndex === -1) {
        playTrackAtIndex(roomId, 0);
    }
}

const getSanitizedPlaylist = (room) => ({
  playlist: room.playlist,
  nowPlayingIndex: room.nowPlayingIndex,
});
function handleRejectSuggestion(socket, { roomId, suggestionId }) {
  const room = rooms[roomId];
  if (!room || socket.user.id !== room.hostUserId) return;
  const initialLength = room.suggestions.length;
  room.suggestions = room.suggestions.filter(
    (s) => s.suggestionId !== suggestionId
  );
  if (room.suggestions.length < initialLength) {
    io.to(roomId).emit("suggestionsUpdated", room.suggestions);
  }
}
function handleHostPlaybackChange(socket, data) {
    const room = rooms[data.roomId];
    if (!room || socket.user.id !== room.hostUserId || !room.nowPlaying) return;

    // --- THE FIX: PART 2 ---
    // ALWAYS clear the old timers when the host makes a change.
    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);
    // --- END OF FIX ---

    if (data.position !== undefined) { // This block handles SEEKING
        room.nowPlaying.position = data.position;
        room.nowPlaying.startTime = Date.now() - data.position;
        room.isPlaying = true; // Seeking implies we want to be playing

        // --- THE FIX: PART 3 ---
        // Calculate the NEW remaining duration and set a NEW master timer.
        const remainingDuration = room.nowPlaying.track.duration_ms - data.position;
        room.songEndTimer = setTimeout(() => playNextSong(data.roomId), remainingDuration + 1500);
        // --- END OF FIX ---

    } else { // This block handles PLAY/PAUSE
        room.isPlaying = data.isPlaying;
        if (room.isPlaying) {
            room.nowPlaying.startTime = Date.now() - room.nowPlaying.position;
            const remainingDuration = room.nowPlaying.track.duration_ms - room.nowPlaying.position;
            room.songEndTimer = setTimeout(() => playNextSong(data.roomId), remainingDuration + 1500);
        } else {
            // If we pause, we need to save the exact position
            room.nowPlaying.position = Date.now() - room.nowPlaying.startTime;
        }
    }

    // Restart the sync pulse if we are playing
    if (room.isPlaying) {
        room.syncInterval = setInterval(() => { if (room.isPlaying) io.to(data.roomId).emit("syncPulse", getAuthoritativeNowPlaying(room)); }, SYNC_INTERVAL);
    }

    // Broadcast the change to all clients immediately.
    io.to(data.roomId).emit("syncPulse", getAuthoritativeNowPlaying(room));
}

function handleSendMessage(socket, msg) {
  if (!socket.user) return;
  let avatarUrl = socket.user.photos[0].value;
  if (avatarUrl.includes("?sz=")) {
    avatarUrl = avatarUrl.replace(/\?sz=\d+$/, "?sz=128");
  } else if (avatarUrl.includes("=s")) {
    avatarUrl = avatarUrl.replace(/=s\d+.*$/, "=s128-c");
  }
  const message = {
    text: msg.text,
    user: socket.user.displayName,
    userId: socket.user.id,
    avatar: avatarUrl,
  };
  io.to(msg.roomId).emit("newChatMessage", message);
}

// --- UNCHANGED: SERVER LISTEN ---
server.listen(PORT, () =>
  console.log(`Vibe Rooms server is live on http://localhost:${PORT}`)
);
