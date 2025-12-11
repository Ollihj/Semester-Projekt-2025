import express from 'express';
import path from 'path';
import { connect } from '../db/connect.js';
import { play } from './player.js';

// Connect to database and load all tracks into memory
const db = await connect();
const tracks = await loadTracks();

// Store active party data in memory
const currentTracks = new Map();  // Which track is playing at each party
const trackHistory = new Map();   // Last 5 tracks played at each party (to avoid repeats)
const partyMembers = new Map();   // Who's currently in each party (for member count)

const port = process.env.PORT || 3003;
const server = express();

server.use(express.json());
server.use(logRequests);

// API endpoints FIRST
server.get('/api/party/:partyCode/currentTrack', getCurrentTrack);
server.get('/api/party/:partyCode/votes', getVoteCounts);
server.get('/api/party/:partyCode/myvote/:sessionId', getMyVote);
server.post('/api/party/:partyCode/vote', recordVote);
server.post('/api/party/:partyCode/heartbeat', recordHeartbeat);
server.get('/api/party/:partyCode/members', getMemberCount);

// Root route - landing page (EXACT match only)
server.get('/', (request, response) => {
    console.log('✅ ROOT ROUTE - Serving landing.html');
    response.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'landing.html'));
});

// Party route - Use regex to avoid catching files with dots
server.get(/^\/party\/([a-zA-Z0-9-]+)$/, (request, response) => {
    const partyCode = request.params[0];
    console.log('✅ PARTY ROUTE - Serving index.html for party:', partyCode);
    response.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'index.html'));
});

// Static files LAST (CSS, JS, images) - but don't auto-serve index.html
server.use(express.static(path.join(import.meta.dirname, '..', 'frontend'), {
    index: false
}));

server.listen(port, () => console.log('Server running on port', port));

// ENDPOINT HANDLERS

function getCurrentTrack(request, response) {
    const partyCode = request.params.partyCode;
    let track = currentTracks.get(partyCode);
    
    if (!track) {
        // No track playing yet - pick one
        track = pickNextTrack(partyCode);
    }
    
    response.json(track);
}

function getVoteCounts(request, response) {
    const partyCode = request.params.partyCode;
    const track = currentTracks.get(partyCode);
    
    if (!track) {
        return response.json({ upvotes: 0, downvotes: 0 });
    }
    
    // Count votes from database
    db.query(`
        select vote_type, count(*) as count
        from votes
        where party_code = $1 and track_id = $2
        group by vote_type
    `, [partyCode, track.track_id])
    .then(result => {
        let upvotes = 0;
        let downvotes = 0;
        
        for (const row of result.rows) {
            if (row.vote_type === 'up') upvotes = parseInt(row.count);
            if (row.vote_type === 'down') downvotes = parseInt(row.count);
        }
        
        response.json({ upvotes, downvotes });
    });
}

function getMyVote(request, response) {
    const partyCode = request.params.partyCode;
    const sessionId = request.params.sessionId;
    const track = currentTracks.get(partyCode);
    
    if (!track) {
        return response.json({ myVote: null });
    }
    
    // Check if this specific user has voted on this track
    db.query(`
        select vote_type
        from votes
        where party_code = $1 and track_id = $2 and session_id = $3
    `, [partyCode, track.track_id, sessionId])
    .then(result => {
        if (result.rows.length > 0) {
            response.json({ myVote: result.rows[0].vote_type });
        } else {
            response.json({ myVote: null });
        }
    });
}

function recordVote(request, response) {
    const partyCode = request.params.partyCode;
    const { vote, sessionId } = request.body;
    const track = currentTracks.get(partyCode);
    
    if (!track) {
        return response.status(404).json({ error: 'No track playing' });
    }
    
    if (vote !== 'up' && vote !== 'down') {
        return response.status(400).json({ error: 'Vote must be "up" or "down"' });
    }
    
    if (!sessionId) {
        return response.status(400).json({ error: 'Session ID required' });
    }
    
    // Store vote in database
    // If this user already voted on this track, update their vote
    db.query(`
        insert into votes (party_code, track_id, session_id, vote_type)
        values ($1, $2, $3, $4)
        on conflict (party_code, track_id, session_id)
        do update set vote_type = $4, voted_at = now()
    `, [partyCode, track.track_id, sessionId, vote])
    .then(() => {
        response.json({ success: true });
    })
    .catch(error => {
        console.error('Database error:', error.message);
        response.status(500).json({ error: 'Failed to store vote' });
    });
}

function recordHeartbeat(request, response) {
    const partyCode = request.params.partyCode;
    const { sessionId } = request.body;
    
    if (!sessionId) {
        return response.status(400).json({ error: 'Session ID required' });
    }
    
    // Get or create the members map for this party
    let members = partyMembers.get(partyCode);
    if (!members) {
        members = new Map();
        partyMembers.set(partyCode, members);
    }
    
    // Record when this user was last seen
    members.set(sessionId, Date.now());
    
    response.json({ success: true });
}

function getMemberCount(request, response) {
    const partyCode = request.params.partyCode;
    const members = partyMembers.get(partyCode);
    
    if (!members) {
        return response.json({ count: 0 });
    }
    
    // Remove members who haven't been seen in 15 seconds
    const now = Date.now();
    const timeout = 15000;  // 15 seconds
    
    let activeCount = 0;
    for (const [sessionId, lastSeen] of members.entries()) {
        if (now - lastSeen < timeout) {
            activeCount++;
        } else {
            members.delete(sessionId);  // Clean up inactive members
        }
    }
    
    response.json({ count: activeCount });
}

// TRACK SELECTION ALGORITHM

async function pickNextTrack(partyCode) {
    // Step 1: Get recently played tracks (to avoid repeats)
    let recentTracks = trackHistory.get(partyCode) || [];
    
    // Step 2: Get all votes for this party
    const voteResult = await db.query(`
        select 
            track_id,
            sum(case when vote_type = 'up' then 1 else -1 end) as score
        from votes
        where party_code = $1
        group by track_id
        order by score desc
    `, [partyCode]);
    
    // Step 3: Find tracks the party LIKES (more upvotes than downvotes)
    const likedResult = await db.query(`
        select 
            track_id,
            sum(case when vote_type = 'up' then 1 else -1 end) as score
        from votes
        where party_code = $1
        group by track_id
        having sum(case when vote_type = 'up' then 1 else -1 end) > 0
    `, [partyCode]);
    
    const likedTrackIds = likedResult.rows.map(r => r.track_id);
    const likedTracks = tracks.filter(t => likedTrackIds.includes(t.track_id));
    
    if (likedTracks.length > 0) {
        const categories = likedTracks.map(t => getCategory(t.track_id));
        console.log(`[${partyCode}] Party likes: ${categories.join(', ')}`);
    }
    
    // Step 4: Score every track
    let bestTrack = null;
    let bestScore = -999999;
    
    for (const track of tracks) {
        // Skip if played recently
        if (recentTracks.includes(track.track_id)) {
            continue;
        }
        
        // Get vote score (0 if nobody voted on this track)
        let voteScore = 0;
        const votedTrack = voteResult.rows.find(v => v.track_id === track.track_id);
        if (votedTrack) {
            voteScore = parseInt(votedTrack.score);
        }
        
        // Calculate similarity bonus
        let similarityBonus = 0;
        for (const likedTrack of likedTracks) {
            // Same category? Give it bonus points
            if (getCategory(track.track_id) === getCategory(likedTrack.track_id)) {
                similarityBonus += 2;
            }
            
            // Same artist? Give it even more bonus points
            if (track.artist === likedTrack.artist) {
                similarityBonus += 3;
            }
        }
        
        // Total score = direct votes + similarity bonus
        const totalScore = voteScore + similarityBonus;
        
        // Keep track of the best option
        if (totalScore > bestScore || (totalScore === bestScore && Math.random() < 0.1)) {
            bestScore = totalScore;
            bestTrack = track;
        }
    }
    
    // Step 5: If all scores are 0 (no votes yet), pick random
    if (!bestTrack || bestScore === 0) {
        const availableTracks = tracks.filter(t => !recentTracks.includes(t.track_id));
        const randomIndex = Math.floor(Math.random() * availableTracks.length);
        bestTrack = availableTracks[randomIndex];
    }
    
    console.log(`[${partyCode}] Playing: "${bestTrack.title}" (${getCategory(bestTrack.track_id)})`);
    
    // Step 6: Remember this track (so we don't repeat it soon)
    recentTracks.push(bestTrack.track_id);
    if (recentTracks.length > 5) {
        recentTracks = recentTracks.slice(-5);  // Keep only last 5
    }
    trackHistory.set(partyCode, recentTracks);
    
    // Step 7: Add timestamp (so frontend knows when it started)
    const startedAt = Date.now();
    const trackWithTimestamp = {
        ...bestTrack,
        startedAt: startedAt
    };
    
    currentTracks.set(partyCode, trackWithTimestamp);
    
    // Step 8: Start playing (when it finishes, pick next track automatically)
    play(partyCode, bestTrack.track_id.toString(), bestTrack.duration, startedAt, () => {
        currentTracks.delete(partyCode);
        pickNextTrack(partyCode);
    });
    
    return trackWithTimestamp;
}

// HELPER FUNCTIONS

function getCategory(trackId) {
    // We organized tracks by ID ranges
    const id = parseInt(trackId);
    if (id >= 1000 && id < 2000) return 'pop';
    if (id >= 2000 && id < 3000) return 'chill';
    if (id >= 3000 && id < 4000) return 'energy';
    if (id >= 4000 && id < 5000) return 'party';
    if (id >= 5000 && id < 6000) return 'running';
    if (id >= 6000 && id < 7000) return 'relaxing';
    return 'other';
}

async function loadTracks() {
    const result = await db.query('select track_id, title, artist, duration from tracks');
    console.log(`Loaded ${result.rows.length} tracks from database`);
    return result.rows;
}

function logRequests(request, response, next) {
    console.log(new Date().toISOString(), request.method, request.url);
    next();
}