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
const URL_EXPIRATION_LIMIT = 5 * 60 * 1000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let rooms = {}; // This is our "Hot Cache" for live data
let userSockets = {};
const userToRoomMap = {}; // <-- THE NEW AUTHORITATIVE MAP
const searchCache = new Map();
const reconnectionTimers = {};
const isUserJoining = new Set(); // We'll keep this lock

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
  socket.on("leaveRoom", ({ roomId }) => handleIntentionalLeave(socket, roomId)); 
  socket.on("disconnect", () => handleLeaveRoom(socket));
  socket.on("sendMessage", (msg) => handleSendMessage(socket, msg));
   socket.on('requestFreshSync', ({ roomId }) => {
        const room = rooms[roomId];
        // The server immediately replies to ONLY THE REQUESTING SOCKET
        // with the most current playback state.
        if (room && room.nowPlaying) {
            socket.emit('syncPulse', getAuthoritativeNowPlaying(room));
        }
    });
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


// --- UNCHANGED: Core Room Lifecycle Logic ---
function handleLeaveRoom(socket) {
    const userSocketInfo = userSockets[socket.id];
    if (!userSocketInfo || !socket.user) return;
    const { user, roomId } = userSocketInfo;
    
    // If a timer already exists for this user, do nothing.
    if (reconnectionTimers[user.id]) return;
    
    console.log(`[Disconnect] User ${user.displayName} disconnected. Starting grace period timer for room ${roomId}.`);
    reconnectionTimers[user.id] = setTimeout(() => {
        console.log(`[Grace Period Expired] Processing full leave for ${user.displayName}.`);
        processUserLeave(socket, roomId);
        delete reconnectionTimers[user.id];
    }, RECONNECTION_GRACE_PERIOD);
}

// This handles the new 'leaveRoom' event from the client. It's an intentional action.
async function handleIntentionalLeave(socket, roomId) {
    if (!socket.user) return;
    const user = socket.user;

    // A user leaving is a definitive action. CANCEL any grace period timer.
    if (reconnectionTimers[user.id]) {
        clearTimeout(reconnectionTimers[user.id]);
        delete reconnectionTimers[user.id];
    }
    console.log(`[Intentional Leave] User ${user.displayName} has chosen to leave room ${roomId}.`);
    await processUserLeave(socket, roomId);
}

// This is the single, authoritative cleanup function.
async function processUserLeave(socket, roomId) {
    const room = rooms[roomId];
    const user = socket.user;
    if (!room || !user || !room.listeners[user.id]) {
        // If the user isn't in this room's listener list, there's nothing to do.
        return;
    }

    console.log(`[Cleanup] Processing leave for ${user.displayName} from room ${roomId}`);
    
    const wasHost = room.hostUserId === user.id;

    // Remove user from all state tracking
    delete room.listeners[user.id];
    delete userSockets[socket.id];
    delete userToRoomMap[user.id];
    socket.leave(roomId);

    // Broadcast the leave message
    io.to(roomId).emit("newChatMessage", {
        system: true,
        text: `${user.displayName} has left the vibe.`,
    });

    // Handle Host Migration
    const remainingListeners = Object.values(room.listeners);
    if (wasHost && remainingListeners.length > 0) {
        const newHost = remainingListeners[0];
        room.hostUserId = newHost.user.id;
        await supabase.from("rooms").update({ host_user_id: newHost.user.id }).eq("id", roomId);
        
        const newHostSocket = io.sockets.sockets.get(newHost.socketId);
        if (newHostSocket) {
            newHostSocket.emit("hostAssigned");
            newHostSocket.emit("newChatMessage", { system: true, text: "👑 You are now the host of this room!" });
            newHostSocket.broadcast.to(roomId).emit("newChatMessage", { system: true, text: `👑 ${newHost.user.displayName} is now the host.` });
        }
    }

    // Update user lists for remaining clients
    const updatedUserList = generateUserList(room);
    io.to(roomId).emit("updateUserList", updatedUserList);
    io.to(roomId).emit("updateListenerCount", updatedUserList.length);
    
    // Handle room deletion if it's now empty
   const finalListenerCount = Object.keys(room.listeners).length;

if (finalListenerCount === 0) {
    // Only set a deletion timer if one isn't already running.
    if (!room.deletionTimer) {
        console.log(`[Room Teardown] Room ${roomId} is now empty. Starting deletion timer.`);
        room.deletionTimer = setTimeout(async () => {
            // Final check: Is the room still in the global list and STILL empty?
            if (rooms[roomId] && Object.keys(rooms[roomId].listeners).length === 0) {
                if (room.songEndTimer) clearTimeout(room.songEndTimer);
                if (room.syncInterval) clearInterval(room.syncInterval);
                
                // Perform the deletion
                await supabase.from("rooms").delete().eq("id", roomId);
                delete rooms[roomId];
                
                console.log(`[Room Teardown] Room ${roomId} has been deleted.`);
                broadcastLobbyData();
            }
        }, 30 * 1000); // 30-second timer
    }
}
// ALWAYS broadcast the lobby data after a user leaves so the count updates.
broadcastLobbyData();
}

// This is the new, streamlined join handler.
async function handleJoinRoom(socket, roomSlug) {
    const user = socket.user;

    // This is a definitive action. Cancel any pending leave timer from a previous disconnect.
    if (reconnectionTimers[user.id]) {
        console.log(`[Join Override] User ${user.displayName} is joining a room. Cancelling pending leave timer.`);
        clearTimeout(reconnectionTimers[user.id]);
        delete reconnectionTimers[user.id];
    }

    // Find the user's previous room using our authoritative map.
    const oldRoomId = userToRoomMap[user.id];
    const { data: newRoomData } = await supabase.from('rooms').select('id').eq('slug', roomSlug).single();
    if (!newRoomData) return socket.emit('roomNotFound');
    const newRoomId = newRoomData.id.toString();

    // If the user is switching to a DIFFERENT room, force an immediate leave from the old one.
    if (oldRoomId && oldRoomId !== newRoomId) {
        console.log(`[Room Switch] Forcing user ${user.displayName} to leave ${oldRoomId} before joining ${newRoomId}`);
        await processUserLeave(socket, oldRoomId);
    }
    
    // --- From here, the join logic is standard and safe ---
    const roomIdToJoin = newRoomId;
    if (!rooms[roomIdToJoin]) {
        // Standard hydration logic...
        const { data: roomData, error: roomError } = await supabase.from('rooms').select('*, vibes(*)').eq('id', roomIdToJoin).single();
        if (roomError || !roomData) return socket.emit('roomNotFound');
        const { data: dbTracks } = await supabase.from('playlist_tracks').select('*').eq('room_id', roomIdToJoin).order('position_in_queue');
        const completePlaylist = (dbTracks || []).map(track => ({ ...track, url: `https://www.youtube.com/watch?v=${track.video_id}` }));
        rooms[roomIdToJoin] = {
            id: roomIdToJoin, slug: roomSlug, name: roomData.name, vibe: roomData.vibes,
            hostUserId: roomData.host_user_id, nowPlayingIndex: roomData.now_playing_index,
            playlist: completePlaylist, listeners: {}, suggestions: [],
            nowPlaying: null, songEndTimer: null, deletionTimer: null, isPlaying: false,
        };
    }
    
    let room = rooms[roomIdToJoin];

    // Don't re-add if they're already there (covers a simple reload scenario)
    if (!room.listeners[user.id]) {
        socket.join(roomIdToJoin);
        userToRoomMap[user.id] = roomIdToJoin;
        room.listeners[user.id] = { socketId: socket.id, user: user };
        io.to(roomIdToJoin).emit("newChatMessage", { system: true, text: `${user.displayName} has joined the vibe.` });
    }
    
    userSockets[socket.id] = { user: user, roomId: roomIdToJoin };
    
    // Host assignment logic
    if (Object.keys(room.listeners).length === 1 && room.hostUserId !== user.id) {
        room.hostUserId = user.id;
        await supabase.from("rooms").update({ host_user_id: user.id }).eq("id", roomIdToJoin);
    }
    
    // Standard state emission
    socket.emit("roomState", getSanitizedRoomState(room, room.hostUserId === user.id, user));
    const userList = generateUserList(room);
    io.to(roomIdToJoin).emit("updateUserList", userList);
    io.to(roomIdToJoin).emit("updateListenerCount", userList.length);
    broadcastLobbyData();
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
        // --- THE MEMORY CRASH FIX ---
        // We add two critical flags to yt-dlp to prevent it from loading huge playlists.
        // 1. `noPlaylist`: If the URL is a single video in a playlist, this flag
        //    tells yt-dlp to ONLY get that single video.
        // 2. `playlistItems`: If the URL is a playlist, this flag limits the
        //    download to the first 10 items. This prevents memory overflow.
        const fullInfo = await ytDlpExec(url, { 
            dumpSingleJson: true,
            noPlaylist: true,      // Add this line
            playlistItems: '1-10'  // Add this line
        });
        // --- END OF FIX ---
        
        let tracksToProcess = fullInfo.entries ? fullInfo.entries : [fullInfo];

        // The rest of the logic is now safe because `tracksToProcess` will never be huge.
        const trackObjects = tracksToProcess.filter(info => info && info.id).map(info => ({
            videoId: info.id,
            name: info.title,
            artist: info.uploader || info.channel,
            albumArt: info.thumbnails?.pop()?.url || "/assets/placeholder.svg",
            duration_ms: info.duration * 1000,
        }));

        if (isHost) {
            const tracksForDb = trackObjects.map((track, index) => ({
                room_id: roomId, added_by_user_id: socket.user.id, video_id: track.videoId,
                name: track.name, artist: track.artist, album_art_url: track.albumArt,
                duration_ms: track.duration_ms, position_in_queue: room.playlist.length + index,
            }));
            const { data: newDbTracks, error } = await supabase.from('playlist_tracks').insert(tracksForDb).select();
            if (error) throw error;
            
            const finalTracks = newDbTracks.map(dbTrack => ({
                ...trackObjects.find(t => t.videoId === dbTrack.video_id),
                id: dbTrack.id,
                albumArt: dbTrack.album_art_url
            }));

            room.playlist.push(...finalTracks);
            io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
            if (room.nowPlayingIndex === -1) playTrackAtIndex(roomId, 0);

        } else { // Guest Suggestion
            const suggestions = trackObjects.map((track) => ({
                ...track,
                suggestionId: `sugg_${Date.now()}_${Math.random()}`,
                suggester: { id: socket.user.id, name: socket.user.displayName }
            }));
            room.suggestions.push(...suggestions);
            io.to(roomId).emit("suggestionsUpdated", room.suggestions);
        }
    } catch (e) {
        // A specific error can occur if a playlist is empty or unavailable, which is now safe to ignore.
        if (e.stderr && e.stderr.includes('This playlist is empty')) {
             socket.emit("newChatMessage", { system: true, text: "This playlist appears to be empty." });
        } else {
             console.error("yt-dlp error or DB error:", e);
             socket.emit("newChatMessage", { system: true, text: "Sorry, that link could not be processed." });
        }
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

async function playTrackAtIndex(roomId, index) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.songEndTimer) clearTimeout(room.songEndTimer);
    if (room.syncInterval) clearInterval(room.syncInterval);
    
    if (index < 0 || index >= room.playlist.length) {
        room.nowPlaying = null; isPlaying = false; room.nowPlayingIndex = -1;
        await supabase.from('rooms').update({ now_playing_index: -1 }).eq('id', roomId);
        io.to(roomId).emit("newSongPlaying", null);
        return;
    }
    
    let track = room.playlist[index];
    if (!track) return;
    
    // --- The Simple Rule: ALWAYS get a fresh URL right before playing. ---
    // This is the SINGLE ~5-second load.
    const playableUrl = await getPlayableUrl(track.video_id);
    if (!playableUrl) {
        io.to(roomId).emit("newChatMessage", { system: true, text: `Skipping "${track.name}" (unavailable).` });
        return playNextSong(roomId);
    }
    
    // Update server state.
    room.nowPlayingIndex = index;
    room.nowPlaying = { track: track, startTime: Date.now(), position: 0 };
    room.isPlaying = true;
    
    // Set new server timers.
    room.songEndTimer = setTimeout(() => playNextSong(roomId), track.duration_ms + 1500);
    room.syncInterval = setInterval(() => { 
        if (room && room.isPlaying) io.to(roomId).emit("syncPulse", getAuthoritativeNowPlaying(room)); 
    }, SYNC_INTERVAL);
    
    // --- The Golden Rule: Broadcast ONE complete payload to EVERYONE. ---
    const payload = {
        ...getAuthoritativeNowPlaying(room),
        url: playableUrl
    };
    
    console.log(`[Playback] Broadcasting new song "${track.name}" to room ${roomId}.`);
    io.to(roomId).emit("newSongPlaying", payload);
    io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));
    broadcastLobbyData();
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
    if (!room) return;

    let nextIndex = room.nowPlayingIndex + 1;
    // Loop back to the start if the playlist ends.
    if (nextIndex >= room.playlist.length) {
        nextIndex = 0;
    }
    playTrackAtIndex(roomId, nextIndex);
}

function playPrevSong(roomId) {
  const room = rooms[roomId];
  if (room && room.nowPlayingIndex > 0) {
      playTrackAtIndex(roomId, room.nowPlayingIndex - 1);
  }
}
const getAuthoritativeNowPlaying = (room) => {
    if (!room || !room.nowPlaying) return null;

    const authoritativeState = {
        track: room.nowPlaying.track,
        isPlaying: room.isPlaying,
        position: room.isPlaying ? (Date.now() - room.nowPlaying.startTime) : room.nowPlaying.position,
        serverTimestamp: Date.now(),
        nowPlayingIndex: room.nowPlayingIndex,
    };
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
    
    try {
        const { data: newDbTrack, error } = await supabase.from('playlist_tracks').insert({
            room_id: roomId, added_by_user_id: suggester.id, video_id: trackData.videoId,
            name: trackData.name, artist: trackData.artist, album_art_url: trackData.albumArt,
            duration_ms: trackData.duration_ms, position_in_queue: room.playlist.length,
        }).select().single();

        if (error) throw error;
        
        // --- The Thumbnail Fix ---
        // Create the final object for memory with the correct `albumArt` key.
        const finalTrackObject = { ...trackData, id: newDbTrack.id };
        room.playlist.push(finalTrackObject);

        io.to(roomId).emit("suggestionsUpdated", room.suggestions);
        io.to(roomId).emit("playlistUpdated", getSanitizedPlaylist(room));

        if (room.nowPlayingIndex === -1) playTrackAtIndex(roomId, 0);

    } catch (dbError) {
        console.error("Failed to approve suggestion due to DB error:", dbError);
        room.suggestions.splice(suggestionIndex, 0, approvedSuggestion);
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

    // Update the server's master state based on the host's action.
    if (data.position !== undefined) { // SEEK action
        room.nowPlaying.position = data.position;
        room.nowPlaying.startTime = Date.now() - data.position;
        room.isPlaying = true; // Seeking implies playing.
    } else { // PLAY/PAUSE action
        room.isPlaying = data.isPlaying;
        if (room.isPlaying) {
            room.nowPlaying.startTime = Date.now() - room.nowPlaying.position;
        } else {
            room.nowPlaying.position = Date.now() - room.nowPlaying.startTime;
        }
    }
    
    // Broadcast the NEW, authoritative state to EVERYONE in the room.
    console.log(`[Host Action] Broadcasting new playback state for room ${data.roomId}`);
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
