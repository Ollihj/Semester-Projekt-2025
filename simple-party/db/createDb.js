import { upload } from 'pg-upload';
import { connect } from './connect.js';

console.log('Recreating database...');

const db = await connect();

console.log('Dropping tables...');
await db.query('drop table if exists votes');
await db.query('drop table if exists tracks');
console.log('All tables dropped.');

console.log('Recreating tables...');

// Tracks table (from skeleton)
await db.query(`
    create table tracks (
        track_id bigint primary key,
        title text not null,
        artist text not null,
        duration int not null
    )
`);

// UPDATED: Votes table with session_id for individual user tracking
await db.query(`
    create table votes (
        party_code text not null,
        track_id bigint not null,
        session_id text not null,
        vote_type text not null check (vote_type in ('up', 'down')),
        voted_at timestamp default now(),
        primary key (party_code, track_id, session_id)
    )
`);

console.log('Tables recreated.');

console.log('Importing data from CSV files...');
await upload(db, 'db/short-tracks.csv', `
    copy tracks (track_id, title, artist, duration)
    from stdin
    with csv header`);
console.log('Data imported.');

await db.end();

console.log('Database recreated.');