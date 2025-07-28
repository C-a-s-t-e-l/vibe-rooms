// public/js/room.js (Complete, Final Corrected Version)

document.addEventListener('DOMContentLoaded', () => {
    // --- UTILITY FUNCTIONS ---
    const getInitials = (name) => {
        if (!name) return '??';
        const parts = name.split(' ');
        if (parts.length > 1) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    };

    const formatTime = (ms) => {
        if (!ms || isNaN(ms)) return '0:00';
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    };

    // --- INITIALIZATION ---
    console.log('Room script loaded.');
    const socket = io();
    let currentUser;
    let currentRoomId = window.location.pathname.split('/').pop();
    let nowPlayingInterval;
    let isHost = false;
    let spotifyPlayer;
    let youtubePlayer;
    let currentTrackDuration = 0;
    let audioContextUnlocked = false;
    let currentTrackSource = null;

    // --- DOM ELEMENTS ---
    const roomBackground = document.getElementById('room-background');
    const roomNameDisplay = document.getElementById('room-name-display');
    const listenerCountDisplay = document.getElementById('listener-count-display');
    const hostControlsWrapper = document.getElementById('host-controls-wrapper');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const nowPlayingCard = document.querySelector('.now-playing-card');
    const nowPlayingArt = document.getElementById('now-playing-art');
    const nowPlayingName = document.getElementById('now-playing-name');
    const nowPlayingArtist = document.getElementById('now-playing-artist');
    const currentTimeDisplay = document.getElementById('current-time');
    const totalTimeDisplay = document.getElementById('total-time');
    const progressBar = document.getElementById('progress-bar');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const queueList = document.getElementById('queue-list');
    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const linkForm = document.getElementById('link-form');
    const linkInput = document.getElementById('link-input');

    // --- AUDIO UNLOCK (FIX FOR BROWSER AUTOPLAY) ---
    const unlockAudio = () => {
        if (audioContextUnlocked) return;
        if (youtubePlayer && typeof youtubePlayer.unMute === 'function') {
            youtubePlayer.unMute();
            youtubePlayer.setVolume(volumeSlider.value);
            audioContextUnlocked = true;
            console.log("Audio context unlocked by user gesture.");

            if (youtubePlayer.getPlayerState() === YT.PlayerState.CUED) {
                youtubePlayer.playVideo();
            }

            document.removeEventListener('click', unlockAudio);
            document.removeEventListener('keydown', unlockAudio);
        }
    };
    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    
    // --- SPOTIFY & YOUTUBE SETUP ---
    const token = localStorage.getItem('spotifyAccessToken');
    if (!token) { window.location.href = '/'; return; }
    
    const spotifyApi = new SpotifyWebApi();
    spotifyApi.setAccessToken(token);
    
    window.onSpotifyWebPlaybackSDKReady = () => {
        spotifyPlayer = new Spotify.Player({
            name: 'Vibe Rooms Player',
            getOAuthToken: cb => { cb(token); }
        });
        spotifyPlayer.addListener('player_state_changed', (state) => {
            if (!state || currentTrackSource !== 'spotify') return;
            const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
            const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
            playPauseBtn.innerHTML = state.paused ? playIcon : pauseIcon;
        });
        spotifyPlayer.addListener('ready', ({ device_id }) => console.log('Room Player is ready with Device ID', device_id));
        spotifyPlayer.connect();
    };

    window.onYouTubeIframeAPIReady = () => {
        youtubePlayer = new YT.Player('youtube-player', {
            height: '360', width: '640', playerVars: { 'playsinline': 1, 'controls': 0 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    };

    function onPlayerReady(event) {
        console.log('YouTube Player is ready.');
        event.target.setVolume(volumeSlider.value);
        if (audioContextUnlocked) {
            event.target.unMute();
        }
    }

    function onPlayerStateChange(event) {
        if (currentTrackSource !== 'youtube') return;

        const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`;
        const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 19h4V5h-4v14M6 19h4V5H6v14Z"/></svg>`;
        
        if (event.data === YT.PlayerState.PLAYING) {
            playPauseBtn.innerHTML = pauseIcon;
        } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
            playPauseBtn.innerHTML = playIcon;
        }
        
        if (event.data === YT.PlayerState.CUED && audioContextUnlocked) {
            youtubePlayer.playVideo();
        }
    }

    spotifyApi.getMe().then(user => {
        currentUser = user;
        socket.emit('joinRoom', { roomId: currentRoomId, spotifyUser: currentUser });
    }).catch(() => {
        localStorage.removeItem('spotifyAccessToken');
        window.location.href = '/';
    });

    // --- UI RENDERING FUNCTIONS ---
    const renderChatMessage = (message) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message';
        const initials = getInitials(message.user);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        msgDiv.innerHTML = `
            <div class="chat-message__avatar">${initials}</div>
            <div class="chat-message__content">
                <div class="chat-message__header">
                    <span class="chat-message__username">${message.user}</span>
                    <span class="chat-message__timestamp">${timestamp}</span>
                </div>
                <p class="chat-message__text">${message.text}</p>
            </div>
        `;
        const usernameEl = msgDiv.querySelector('.chat-message__username');
        if (isHost && currentUser && currentUser.id !== message.userId) {
            usernameEl.classList.add('kickable');
            usernameEl.title = 'Click to moderate';
            usernameEl.onclick = () => {
                if (confirm(`Do you want to kick ${message.user} from the room?`)) {
                    socket.emit('kickUser', { roomId: currentRoomId, targetSpotifyId: message.userId });
                }
            };
        }
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };
    
    const renderSystemMessage = (text) => {
        const p = document.createElement('p');
        p.className = 'system-message';
        p.textContent = text;
        chatMessages.appendChild(p);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    const updateNowPlayingUI = (nowPlaying) => {
        clearInterval(nowPlayingInterval);
        currentTrackDuration = 0;
        currentTrackSource = nowPlaying ? nowPlaying.track.source : null;

        if (!nowPlaying || !nowPlaying.track) {
            nowPlayingCard.classList.remove('is-playing');
            nowPlayingArt.src = '/assets/placeholder.svg';
            nowPlayingName.textContent = 'Nothing Playing';
            nowPlayingArtist.textContent = 'Add a song to start the vibe';
            roomBackground.style.backgroundImage = 'none';
            progressBar.style.width = '0%';
            currentTimeDisplay.textContent = '0:00';
            totalTimeDisplay.textContent = '0:00';
            return;
        }

        nowPlayingCard.classList.add('is-playing');
        const track = nowPlaying.track;
        currentTrackDuration = track.duration_ms;
        nowPlayingArt.src = track.albumArt;
        nowPlayingName.textContent = track.name;
        nowPlayingArtist.textContent = track.artist;
        roomBackground.style.backgroundImage = `url('${track.albumArt}')`;
        totalTimeDisplay.textContent = formatTime(track.duration_ms);

        nowPlayingInterval = setInterval(() => {
            const elapsedTime = Date.now() - nowPlaying.startTime;
            if (elapsedTime >= track.duration_ms) {
                clearInterval(nowPlayingInterval);
                progressBar.style.width = '100%';
                return;
            }
            const progressPercent = (elapsedTime / track.duration_ms) * 100;
            progressBar.style.width = `${progressPercent}%`;
            currentTimeDisplay.textContent = formatTime(elapsedTime);
        }, 500);
    };

    const updateQueueUI = (queue) => {
        queueList.innerHTML = '';
        if (!queue || queue.length === 0) {
            queueList.innerHTML = '<p class="system-message">Queue is empty</p>';
            return;
        }
        queue.forEach((track, index) => {
            queueList.innerHTML += `
                <div class="queue-item">
                    <span class="queue-item__number">${index + 1}</span>
                    <img src="${track.albumArt}" alt="${track.name}" class="queue-item__art">
                    <div class="track-info">
                        <p>${track.name}</p>
                        <p>${track.artist}</p>
                    </div>
                    <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>
                </div>
            `;
        });
    };
    
    const displaySearchResults = (tracks) => {
        searchResults.innerHTML = '';
        if (!tracks || tracks.length === 0) return;
        
        tracks.slice(0, 5).forEach(track => {
            const trackDiv = document.createElement('div');
            trackDiv.className = 'queue-item';
            trackDiv.style.cursor = 'pointer';
            const albumArtUrl = track.album.images.find(img => img.height >= 48)?.url || '/assets/placeholder.svg';
            
            trackDiv.innerHTML = `
                <span class="queue-item__number">
                    <svg style="width:24px;height:24px" viewBox="0 0 24 24"><path fill="currentColor" d="M19,11H13V5h-2v6H5v2h6v6h2v-6h6V11z" /></svg>
                </span>
                <img src="${albumArtUrl}" alt="${track.name}" class="queue-item__art">
                <div class="track-info">
                    <p>${track.name}</p>
                    <p>${track.artists[0].name}</p>
                </div>
                <span class="queue-item__duration">${formatTime(track.duration_ms)}</span>
            `;
            trackDiv.onclick = () => {
                socket.emit('addSong', { roomId: currentRoomId, trackId: track.id, token });
                searchInput.value = '';
                searchResults.innerHTML = '';
                searchResults.classList.remove('is-visible');
            };
            searchResults.appendChild(trackDiv);
        });
    };

    // --- EVENT LISTENERS ---
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (chatInput.value.trim() !== '') {
            // FIX #1: Changed 'message' to 'text' and 'userName' to 'user' to match the receiver.
            socket.emit('sendMessage', { 
                roomId: currentRoomId, 
                text: chatInput.value, 
                user: currentUser.display_name,
                userId: currentUser.id
            });
            chatInput.value = '';
        }
    });

    searchForm.addEventListener('submit', (e) => e.preventDefault());
    searchInput.addEventListener('input', () => {
        const query = searchInput.value;
        if (query.trim() !== '') {
            searchResults.classList.add('is-visible');
            spotifyApi.searchTracks(query, { limit: 10 }).then(data => displaySearchResults(data.tracks.items));
        } else {
            searchResults.classList.remove('is-visible');
        }
    });

    document.addEventListener('click', (e) => {
        const searchContainer = document.querySelector('.search-container');
        if (searchContainer && !searchContainer.contains(e.target)) {
            searchResults.classList.remove('is-visible');
        }
    });
    
    linkForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = linkInput.value;
        if (!url.trim()) return;

        const spTrackRegex = /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
        const spPlaylistRegex = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;
        const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|)([\w-]{11})/;

        const spTrackMatch = url.match(spTrackRegex);
        const spPlaylistMatch = url.match(spPlaylistRegex);
        const ytMatch = url.match(ytRegex);

        if (spTrackMatch && spTrackMatch[1]) {
            socket.emit('addSong', { roomId: currentRoomId, trackId: spTrackMatch[1], token });
        } else if (spPlaylistMatch && spPlaylistMatch[1]) {
            socket.emit('addPlaylist', { roomId: currentRoomId, playlistId: spPlaylistMatch[1], token });
        } else if (ytMatch && ytMatch[1]) {
            socket.emit('addYouTubeTrack', { roomId: currentRoomId, videoId: ytMatch[1] });
        } else {
            alert("Invalid Link. Please paste a valid Spotify track/playlist or YouTube video link.");
        }
        linkInput.value = '';
    });

    // --- SMART PLAYBACK CONTROLS ---
    playPauseBtn.addEventListener('click', () => {
        if (currentTrackSource === 'spotify' && spotifyPlayer) {
            spotifyPlayer.togglePlay();
        } else if (currentTrackSource === 'youtube' && youtubePlayer) {
            const playerState = youtubePlayer.getPlayerState();
            if (playerState === YT.PlayerState.PLAYING) {
                youtubePlayer.pauseVideo();
            } else {
                youtubePlayer.playVideo();
            }
        }
    });

    prevBtn.addEventListener('click', () => { 
        if (isHost) socket.emit('seekTrack', { roomId: currentRoomId, position_ms: 0 }); 
    });
    
    nextBtn.addEventListener('click', () => { 
        if (isHost) socket.emit('skipTrack', { roomId: currentRoomId }); 
    });

    volumeSlider.addEventListener('input', (e) => {
        const volume = e.target.value;
        if (spotifyPlayer) {
            spotifyPlayer.setVolume(volume / 100);
        }
        if (youtubePlayer && youtubePlayer.setVolume) {
            youtubePlayer.setVolume(volume);
        }
    });

    document.getElementById('progress-bar-container').addEventListener('click', (e) => {
        if (!isHost || currentTrackDuration === 0) return;
        const progressBarContainer = e.currentTarget;
        const clickPositionX = e.offsetX;
        const containerWidth = progressBarContainer.clientWidth;
        const seekProgress = clickPositionX / containerWidth;
        const seekPosition_ms = Math.floor(seekProgress * currentTrackDuration);
        socket.emit('seekTrack', { roomId: currentRoomId, position_ms: seekPosition_ms });
    });
    
    // --- SOCKET.IO HANDLERS ---
    socket.on('roomState', (data) => {
        roomNameDisplay.textContent = data.name;
        updateQueueUI(data.queue);
        updateNowPlayingUI(data.nowPlaying);
        if (currentUser && data.host === currentUser.id) {
            isHost = true;
            hostControlsWrapper.classList.remove('is-guest');
        } else {
            isHost = false;
            hostControlsWrapper.classList.add('is-guest');
        }
    });

    socket.on('newChatMessage', (message) => {
        message.system ? renderSystemMessage(message.text) : renderChatMessage(message);
    });

    socket.on('updateRoomsList', (rooms) => {
        const currentRoomData = rooms.find(r => r.id === currentRoomId);
        if (currentRoomData) {
            listenerCountDisplay.textContent = currentRoomData.listenerCount;
        }
    });

    socket.on('queueUpdated', updateQueueUI);
    
    socket.on('newSongPlaying', (nowPlaying) => {
        updateNowPlayingUI(nowPlaying);
    
        if (!nowPlaying || !nowPlaying.track) {
            if (spotifyPlayer) spotifyPlayer.pause();
            if (youtubePlayer && youtubePlayer.pauseVideo) youtubePlayer.pauseVideo();
            return;
        }
    
        const { track, startTime } = nowPlaying;
        const latency = Date.now() - startTime;
    
        if (track.source === 'spotify') {
            if (youtubePlayer && youtubePlayer.pauseVideo) youtubePlayer.pauseVideo();
            if (spotifyPlayer) {
                spotifyPlayer._options.getOAuthToken(access_token => {
                    fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyPlayer._options.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ uris: [track.uri], position_ms: latency }),
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
                    });
                });
            }
        } else if (track.source === 'youtube') {
            if (spotifyPlayer) spotifyPlayer.pause();
            if (youtubePlayer && youtubePlayer.loadVideoById) {
                // FIX #2: Forcefully unmute and set volume right before loading the new track.
                youtubePlayer.unMute();
                youtubePlayer.setVolume(volumeSlider.value);

                youtubePlayer.loadVideoById({
                    videoId: track.id,
                    startSeconds: Math.floor(latency / 1000)
                });
            }
        }
    });

    socket.on('kicked', ({ roomName }) => {
        alert(`You have been kicked from the room "${roomName}" by the host.`);
        window.location.href = '/';
    });
});