import express from 'express';
import path from 'path';
import { connect } from '../db/connect.js';
import { play } from './player.js';

// Connect to database and load all tracks into memory
const db = await connect();
const tracks = await loadTracks();

// Store active party data in memory
const currentTracks = new Map();
const trackHistory = new Map();
const partyMembers = new Map();

const port = process.env.PORT || 3003;
const server = express();

server.use(express.json());
server.use(logRequests);

// Serve specific static files explicitly
server.get('/styles.css', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'styles.css'));
});

server.get('/landing.css', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'landing.css'));
});

server.get('/index.js', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'index.js'));
});

server.get('/landing.js', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'landing.js'));
});

// API endpoints
server.get('/api/party/:partyCode/currentTrack', getCurrentTrack);
server.get('/api/party/:partyCode/votes', getVoteCounts);
server.get('/api/party/:partyCode/myvote/:sessionId', getMyVote);
server.post('/api/party/:partyCode/vote', recordVote);
server.post('/api/party/:partyCode/heartbeat', recordHeartbeat);
server.get('/api/party/:partyCode/members', getMemberCount);

// Root route - landing page
server.get('/', (request, response) => {
    console.log('Serving landing.html');
    response.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'landing.html'));
});

// Party route
server.get('/party/:partyCode', (request, response) => {
    console.log('Serving index.html for party:', request.params.partyCode);
    response.sendFile(path.join(import.meta.dirname, '..', 'frontend', 'index.html'));
});

server.listen(port, () => console.log('Server running on port', port));

// ENDPOINT HANDLERS

function getCurrentTrack(request, response) {
    const partyCode = request.params.partyCode;
    let track = currentTracks.get(partyCode);
    
    if (!track) {
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
    
    let members = partyMembers.get(partyCode);
    if (!members) {
        members = new Map();
        partyMembers.set(partyCode, members);
    }
    
    members.set(sessionId, Date.now());
    
    response.json({ success: true });
}

function getMemberCount(request, response) {
    const partyCode = request.params.partyCode;
    const members = partyMembers.get(partyCode);
    
    if (!members) {
        return response.json({ count: 0 });
    }
    
    const now = Date.now();
    const timeout = 15000;
    
    let activeCount = 0;
    for (const [sessionId, lastSeen] of members.entries()) {
        if (now - lastSeen < timeout) {
            activeCount++;
        } else {
            members.delete(sessionId);
        }
    }
    
    response.json({ count: activeCount });
}

// TRACK SELECTION ALGORITHM

async function pickNextTrack(partyCode) {
    let recentTracks = trackHistory.get(partyCode) || [];
    
    const voteResult = await db.query(`
        select 
            track_id,
            sum(case when vote_type = 'up' then 1 else -1 end) as score
        from votes
        where party_code = $1
        group by track_id
        order by score desc
    `, [partyCode]);
    
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
    
    let bestTrack = null;
    let bestScore = -999999;
    
    for (const track of tracks) {
        if (recentTracks.includes(track.track_id)) {
            continue;
        }
        
        let voteScore = 0;
        const votedTrack = voteResult.rows.find(v => v.track_id === track.track_id);
        if (votedTrack) {
            voteScore = parseInt(votedTrack.score);
        }
        
        let similarityBonus = 0;
        for (const likedTrack of likedTracks) {
            if (getCategory(track.track_id) === getCategory(likedTrack.track_id)) {
                similarityBonus += 2;
            }
            
            if (track.artist === likedTrack.artist) {
                similarityBonus += 3;
            }
        }
        
        const totalScore = voteScore + similarityBonus;
        
        if (totalScore > bestScore || (totalScore === bestScore && Math.random() < 0.1)) {
            bestScore = totalScore;
            bestTrack = track;
        }
    }
    
    if (!bestTrack || bestScore === 0) {
        const availableTracks = tracks.filter(t => !recentTracks.includes(t.track_id));
        const randomIndex = Math.floor(Math.random() * availableTracks.length);
        bestTrack = availableTracks[randomIndex];
    }
    
    console.log(`[${partyCode}] Playing: "${bestTrack.title}" (${getCategory(bestTrack.track_id)})`);
    
    recentTracks.push(bestTrack.track_id);
    if (recentTracks.length > 5) {
        recentTracks = recentTracks.slice(-5);
    }
    trackHistory.set(partyCode, recentTracks);
    
    const startedAt = Date.now();
    const trackWithTimestamp = {
        ...bestTrack,
        startedAt: startedAt
    };
    
    currentTracks.set(partyCode, trackWithTimestamp);
    
    play(partyCode, bestTrack.track_id.toString(), bestTrack.duration, startedAt, () => {
        currentTracks.delete(partyCode);
        pickNextTrack(partyCode);
    });
    
    return trackWithTimestamp;
}

// HELPER FUNCTIONS

function getCategory(trackId) {
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