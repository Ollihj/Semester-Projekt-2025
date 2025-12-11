// SESSION MANAGEMENT

// Create a unique ID for this browser tab
// Uses sessionStorage so each tab gets its own ID (even in same browser)
let sessionId = sessionStorage.getItem('nexttrack-session-id');
if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem('nexttrack-session-id', sessionId);
}

// STATE VARIABLES

let myCurrentVote = null;       // What I voted (null, 'up', or 'down')
let trackStartTime = null;      // When current track started (timestamp)
let trackDuration = 0;          // How long current track is (milliseconds)

// STARTUP

addEventListener("DOMContentLoaded", () => {
    // Get party code from URL (or create new one)
    const partyCode = getPartyCode();
    history.replaceState(null, '', partyCode);
    
    // Start everything
    setupVotingButtons(partyCode);
    startPolling(partyCode);
    startProgressBar();
    startHeartbeat(partyCode);
});

// PARTY CODE

function getPartyCode() {
    // Check if there's a party code in the URL
    const pathname = window.location.pathname;
    
    // URL format: /party/abc123
    if (pathname.startsWith('/party/')) {
        return pathname.substring(7); // Remove "/party/"
    }
    
    // Old format: /abc123 (still works)
    if (pathname.startsWith('/') && pathname.length > 1) {
        return pathname.substring(1);
    }
    
    // No party code - shouldn't happen with landing page
    // But just in case, generate one
    return crypto.randomUUID().substring(0, 4);
}

// VOTING

function setupVotingButtons(partyCode) {
    // When user clicks upvote button
    document.getElementById('upvoteBtn').addEventListener('click', () => {
        vote(partyCode, 'up');
    });
    
    // When user clicks downvote button
    document.getElementById('downvoteBtn').addEventListener('click', () => {
        vote(partyCode, 'down');
    });
}

async function vote(partyCode, voteType) {
    // Send vote to server
    const response = await fetch(`/api/party/${partyCode}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            vote: voteType,
            sessionId: sessionId 
        })
    });
    
    if (response.ok) {
        // Update the UI immediately
        updateVoteDisplay();
    }
}

async function updateVoteDisplay() {
    const partyCode = getPartyCode();
    
    // Get total vote counts
    const votesResponse = await fetch(`/api/party/${partyCode}/votes`);
    const votesData = await votesResponse.json();
    
    document.getElementById('upvoteCount').textContent = votesData.upvotes;
    document.getElementById('downvoteCount').textContent = votesData.downvotes;
    
    // Get MY vote
    const myVoteResponse = await fetch(`/api/party/${partyCode}/myvote/${sessionId}`);
    const myVoteData = await myVoteResponse.json();
    
    myCurrentVote = myVoteData.myVote;
    
    // Update button styling
    const upvoteButton = document.getElementById('upvoteBtn');
    const downvoteButton = document.getElementById('downvoteBtn');
    
    if (myCurrentVote === 'up') {
        upvoteButton.classList.add('voted');
        downvoteButton.classList.remove('voted');
    } else if (myCurrentVote === 'down') {
        downvoteButton.classList.add('voted');
        upvoteButton.classList.remove('voted');
    } else {
        upvoteButton.classList.remove('voted');
        downvoteButton.classList.remove('voted');
    }
}

// POLLING (Check for track changes)

function startPolling(partyCode) {
    // Check immediately
    updateCurrentTrack(partyCode);
    
    // Then check every 3 seconds
    setInterval(() => {
        updateCurrentTrack(partyCode);
    }, 3000);
}

async function updateCurrentTrack(partyCode) {
    // Get current track from server
    const response = await fetch(`/api/party/${partyCode}/currentTrack`);
    const track = await response.json();
    
    // Update the display
    document.getElementById('partyCode').textContent = partyCode;
    document.getElementById('trackTitle').textContent = track.title;
    document.getElementById('trackArtist').textContent = track.artist;
    document.getElementById('trackGenre').textContent = getGenreLabel(track.track_id);
    
    // Update progress bar info
    trackDuration = track.duration;
    trackStartTime = track.startedAt;  // When the server started playing it
    document.getElementById('totalTime').textContent = formatTime(trackDuration);
    
    // Update vote display
    updateVoteDisplay();
}

// PROGRESS BAR

function startProgressBar() {
    // Update every 100ms (10 times per second)
    setInterval(() => {
        updateProgressBar();
    }, 100);
}

function updateProgressBar() {
    if (!trackStartTime || trackDuration === 0) {
        return;  // No track loaded yet
    }
    
    // Calculate how far through the track we are
    const now = Date.now();
    const elapsed = now - trackStartTime;
    let percentage = (elapsed / trackDuration) * 100;
    
    // Cap at 100%
    if (percentage > 100) {
        percentage = 100;
    }
    
    // Update the progress bar width
    document.getElementById('progressFill').style.width = percentage + '%';
    document.getElementById('currentTime').textContent = formatTime(elapsed);
}

function formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    // Add leading zero to seconds if needed (e.g., 3:05 instead of 3:5)
    const secondsString = seconds < 10 ? '0' + seconds : seconds;
    
    return minutes + ':' + secondsString;
}

// HEARTBEAT (Let server know we're still here)

function startHeartbeat(partyCode) {
    // Send immediately
    sendHeartbeat(partyCode);
    
    // Then send every 5 seconds
    setInterval(() => {
        sendHeartbeat(partyCode);
        updateMemberCount(partyCode);
    }, 5000);
}

async function sendHeartbeat(partyCode) {
    try {
        await fetch(`/api/party/${partyCode}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId })
        });
    } catch (error) {
        console.error('Error sending heartbeat:', error);
    }
}

async function updateMemberCount(partyCode) {
    try {
        const response = await fetch(`/api/party/${partyCode}/members`);
        if (!response.ok) return;
        
        const data = await response.json();
        document.getElementById('memberCount').textContent = data.count;
    } catch (error) {
        console.error('Error fetching member count:', error);
    }
}

// HELPER FUNCTIONS

function getGenreLabel(trackId) {
    // Convert track ID to genre
    const id = parseInt(trackId);
    if (id >= 1000 && id < 2000) return 'Pop';
    if (id >= 2000 && id < 3000) return 'Chill';
    if (id >= 3000 && id < 4000) return 'Energy';
    if (id >= 4000 && id < 5000) return 'Party';
    if (id >= 5000 && id < 6000) return 'Running';
    if (id >= 6000 && id < 7000) return 'Relaxing';
    return 'Music';
}