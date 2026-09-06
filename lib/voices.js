/* The Bee's House, what people actually send.
 *
 * The app cannot post into a WhatsApp group. Nothing can: Meta's Groups
 * API only reaches groups a business creates, capped at eight people,
 * behind business verification, and it explicitly cannot join a group that
 * already exists. So the message is written here and a human presses send.
 *
 * Which turns out to be the better version anyway, because a message a
 * person sends can sound like that person. These are written in the voice
 * of whoever is sending, from what the five of them are actually like:
 *
 *   bee      Hrutik, irritates everybody in a good way, never free at the
 *            weekend, always sweeping, always the one asking to play Cabo
 *            while the rest of the group says no. Keeps a tab of small
 *            things. Listens more than he lets on.
 *   deer     Sharayu, Bolt, whose whole ability is that things aimed at
 *            her do not land.
 *   snake    Shivani, Shed, whose cards are never where you left them.
 *   rhino    Sahil, Charge, two actions where everyone else gets one.
 *   giraffe  Roshan, Hush, who does things the record refuses to describe.
 *
 * Pure data and one function. No DOM, no network, so the same file runs in
 * the browser and in a test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Voices = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* {next} is whoever is up. {me} is the sender. Nothing else is substituted,
   so a stray brace shows up as a stray brace and the tests look for it. */

var HANDOFF = {
  bee: [
    'Played. {next}, you are up. I am not saying what I did.',
    'Your go {next}. I have been ready since this morning.',
    'Done. Also I swept. {next}, you inherit the mess.',
    '{next} it is on you now. I will be here. I am always here.',
    'I played. Somebody tell {next} before the weekend gets in the way.',
    'Moved. {next}. I would explain but I am enjoying this.',
    '{next} your turn. I did something clever. Possibly.',
    'Done. {next} is up. I have already thought about my next turn.',
    'Played. {next}. No notes.',
    'That was me. {next}, go, and be quick, I want another one.',
    '{next} up you get. I have been staring at this for ten minutes.',
    'Turn done. {next}. I am writing all of this down by the way.',
    'Played, swept nothing, harmed nobody. {next}.',
    '{next} you are up and I am watching.',
    'Mine is done. {next}. Take your time, but not too much.'
  ],
  deer: [
    'Played. {next}, go. Nothing landed on me, by the way.',
    'Your turn {next}. Whatever you were planning, try it, see how it goes.',
    'Done. {next} is up.',
    '{next}. Quickly please, I want to see what happens.',
    'Played. {next}. That is all.',
    '{next} your go. I would not bother aiming anything at me.',
    'Done and dusted. {next}.',
    'Moved. {next}, and good luck.',
    '{next} you are up. I have made my situation slightly worse.',
    'Turn taken. {next}.',
    '{next}. Go on then.',
    'Played. Somebody else deal with it. {next}.',
    'Mine is done, {next} is up, everybody carry on.',
    '{next} your move. Nothing to report.',
    'Done. {next}. Try not to be Hrutik about it.'
  ],
  snake: [
    'Played. {next}, your turn. My cards are not where you think they are.',
    'Done. {next}. Anything you learned about me is now out of date.',
    '{next} you are up. Good luck with your notes.',
    'Moved. {next} go.',
    'Played. {next}. Some things have changed. Not saying which.',
    '{next} your turn. Mine looks the same and is not.',
    'Done. {next}. I would check your assumptions.',
    '{next} up you go. I have been busy.',
    'Turn taken, {next}. Everything you knew has a shelf life.',
    'Played. {next}. Enjoy.',
    '{next} your move. Mine was more interesting than it looked.',
    'Done. {next}. Whatever you were about to do, do it anyway.',
    '{next}. Go. See what happens.',
    'Mine is done. {next}, and I would not trust the table.',
    'Played quietly. {next}.'
  ],
  rhino: [
    'Took two. {next}, you get one. Off you go.',
    'Played twice actually. {next} is up.',
    'Done. {next}, and be quick about it.',
    '{next} your turn. I have already finished mine, twice.',
    'Played. {next}.',
    'Done. {next} go.',
    '{next} up.',
    'Turn taken. {next} is next.',
    'Mine is done. {next}.',
    '{next} your move. Make it fast.',
    'Played. Next is {next}. Obviously.',
    'Done here. {next}.',
    '{next}. Go.',
    'That is mine finished. {next} now.',
    'Moved. {next} you are up.'
  ],
  giraffe: [
    'I did something. {next} is up.',
    'Turn passed. {next}. No comment.',
    'Something happened. Nobody heard what. {next}, go.',
    '{next} you are up. Do not ask.',
    'Played. {next}.',
    'Done. {next}. I would rather not go into it.',
    '{next} your turn. Nothing to see here.',
    'That is mine finished. {next}, quietly.',
    'Moved. {next}. The record will show nothing.',
    '{next} up you go.',
    'I have taken my turn. {next} has one waiting.',
    'Done. {next}. No further questions.',
    '{next}. Your move.',
    'Something occurred. {next} is next.',
    'Turn over. {next}, and I said nothing.'
  ]
};

var NUDGE = {
  bee: [
    '{next} it has been a while. I checked. I check a lot.',
    'Still waiting on {next}. Adding this to the tab.',
    '{next}. I know you are busy. I know it is the weekend. Please.',
    'Somebody wake {next} up.',
    '{next} the game is right there. It takes eleven seconds.',
    'Waiting on {next}. I have swept twice since.',
    '{next} I am not rushing you. I am simply mentioning you. Repeatedly.',
    'It is {next}. It has been {next} for some time now.',
    '{next} please. I organised this.',
    'Has anyone seen {next}. Asking as the person whose house this is.',
    '{next} one move and I will stop.',
    'I am being patient about {next}. Everyone can see how patient I am being.',
    '{next}, mate. The cards are waiting. I am waiting. We are all waiting.',
    'Gentle reminder that {next} exists and has a turn.',
    '{next} I will personally bring you food if you play.',
    'This is the third time I have thought about messaging {next}. This is the first time I have done it.',
    '{next} the deck is getting cold.',
    'Still {next}. I am writing this down.'
  ],
  deer: [
    '{next} we are all sitting here.',
    'Waiting on {next}. This is the slowest part of the week.',
    '{next} one tap. That is the whole thing.',
    '{next} your turn is going nowhere and neither are we.',
    'Anyone heard from {next}.',
    '{next}. Come on.',
    'It is still {next}. It has been {next} for a while.',
    '{next} I would like to take my turn at some point today.',
    'Nudging {next}, which is apparently my job now.',
    '{next} play so Hrutik stops messaging.',
    'The game is paused on {next}.',
    '{next}, whenever you have a minute, which you do.',
    'Waiting on {next} and losing interest.',
    '{next} go please.',
    'Still nothing from {next}.',
    '{next} you are holding four people up.',
    'Somebody poke {next}.',
    '{next} it is literally one move.'
  ],
  snake: [
    '{next}, the longer you leave it the less you remember. Just saying.',
    'Still {next}. Take your time, everything is moving anyway.',
    '{next} go.',
    '{next} I have had time to rearrange things. Twice.',
    'Waiting on {next}, who is going to regret waiting.',
    '{next} the table has changed since you last looked.',
    'Still {next}. Your notes are going stale.',
    '{next}. Every minute is a minute of you forgetting.',
    'Nudging {next}, who I hope has a good memory.',
    '{next} play before you forget which slot was which.',
    'It is {next}, and has been for some time.',
    '{next} we are all being very patient and none of us mean it.',
    'Waiting on {next}. Not complaining. Observing.',
    '{next} the game has not moved. I have.',
    'Still on {next}. Interesting.',
    '{next} come and see what has changed.',
    'Reminder for {next}, who is going in blind at this point.',
    '{next}, go on.'
  ],
  rhino: [
    '{next}. Now would be good.',
    'Waiting on {next}. I could have taken four turns by now.',
    '{next} play.',
    '{next} go.',
    'Still {next}.',
    '{next} move.',
    'It is on {next} and has been for ages.',
    '{next} take your turn.',
    'Waiting. {next}.',
    '{next} today please.',
    'Game is stuck on {next}.',
    '{next} eleven seconds. Go.',
    'Nudging {next}. Consider yourself nudged.',
    '{next} come on.',
    'Everyone is waiting for {next}.',
    '{next} I have done mine twice over.',
    'Still nothing. {next}.',
    '{next} play the card.'
  ],
  giraffe: [
    '{next}. Your turn. That is the whole message.',
    'Waiting on {next}. That is all I am going to say.',
    '{next}, whenever you are ready. Genuinely, whenever.',
    '{next}.  Still.',
    'It is {next}. It has been for a while. No pressure.',
    '{next} I have been watching this screen.',
    'Nothing has happened. {next}.',
    '{next}. I noticed.',
    'The game is waiting for {next}. I am also waiting.',
    '{next}, quietly.',
    'Somebody should say something to {next}. This is me doing that.',
    '{next} your move is outstanding.',
    'Still {next}. I will not mention it again. I probably will.',
    '{next}. When you can.',
    'Waiting. On {next}. Specifically.',
    'I am not going to make a thing of this, {next}.',
    '{next} the table has not moved in some time.',
    '{next}, at your convenience, which was earlier.'
  ]
};

/* Past a day. The turn clock already knows, so a nudge at hour two and a
   nudge at hour thirty have no business sounding the same. */
var NUDGE_LATE = {
  bee: [
    '{next} it has been a whole day. A DAY.',
    'Day two of waiting for {next}. I am keeping count. Obviously I am keeping count.',
    '{next} I have swept this floor several times waiting for you.',
    'This has now been on the tab longer than most things on the tab. {next}.',
    '{next} I will accept a move at any hour. Three in the morning. I do not mind.',
    'Reminding everyone that {next} still has not played, and that I noticed first.',
    '{next} genuinely, are you alive.',
    'A day of my life waiting on {next}. Worth it. Probably.',
    'It has been a day, {next}. I am not upset. I am simply mentioning it. Loudly.',
    '{next} the weekend excuse has expired.'
  ],
  deer: [
    'It has been a day, {next}.',
    '{next} this is now genuinely annoying.',
    'Over twenty four hours on {next}. That is a record.',
    '{next} we are going to have to skip you.',
    'A full day. {next}. Come on.',
    '{next} at this point just play badly, it is fine.',
    'Still {next}, one day later.',
    '{next} the round is older than the nudge.'
  ],
  snake: [
    'A day, {next}. You have definitely forgotten your cards by now.',
    '{next} whatever you thought you knew, let it go.',
    'Over a day on {next}. Everything has moved. Some of it by me.',
    '{next} you are going in completely blind and it is your own doing.',
    'Still {next}, twenty four hours later. Fascinating.',
    '{next} your notes are archaeology at this point.',
    'A whole day of {next} not playing. I have made good use of it.',
    '{next} come and find out what changed.'
  ],
  rhino: [
    'A day. {next}.',
    '{next} it has been over twenty four hours. Play.',
    'Still {next}. Still nothing.',
    '{next} we are going to skip you.',
    'One day. One move. {next}.',
    '{next} this is ridiculous now.',
    'Over a day waiting on {next}.',
    '{next} last chance before the skip.'
  ],
  giraffe: [
    'It has been a day, {next}. I am still not going to make a thing of it.',
    '{next}. A whole day. Noted.',
    'Twenty four hours of {next}. I have said nothing until now.',
    '{next} I have been very quiet about this.',
    'A day. {next}. That is all.',
    '{next}, this is the loudest I get.',
    'Still {next}. Still watching.',
    '{next} at some point somebody will skip you and it will not be me. Probably.'
  ]
};

var INVITE = {
  bee: [
    'Right. Cabo. Online. You cannot say no this time, the room is already made.',
    'I made us a Cabo room. Nobody has to be free at the same time. No excuses left.',
    'Cabo. Please. I have been asking for two years.'
  ],
  deer: [
    'Made us a Cabo room. Come and take your seat.',
    'Cabo, but online, so nobody has to be free at once. Get in here.'
  ],
  snake: [
    'A Cabo room. Take a seat before somebody takes yours.',
    'Cabo online. Come and lose.'
  ],
  rhino: [
    'Cabo room is up. Get in.',
    'Made a Cabo room. Claim your seat.'
  ],
  giraffe: [
    'There is a Cabo room. You should probably be in it.',
    'Cabo room. Come.'
  ]
};

var TABLES = { handoff: HANDOFF, nudge: NUDGE, nudgeLate: NUDGE_LATE, invite: INVITE };

/* Deterministic pick, so the same turn always produces the same line and a
   refresh cannot be used to shop for a funnier one. */
function pick(list, salt) {
  var n = 0, s = String(salt || '');
  for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return list[n % list.length];
}

/**
 * @param {string} kind    'handoff' | 'nudge' | 'invite'
 * @param {string} from    sender's animal
 * @param {object} opts    { next, url, salt }
 */
function line(kind, from, opts) {
  opts = opts || {};
  var table = TABLES[kind] || HANDOFF;
  var list = table[from] || table.bee;
  var text = pick(list, (opts.salt || '') + kind + from);
  return text.replace(/\{next\}/g, opts.next || 'somebody');
}

function message(kind, from, opts) {
  opts = opts || {};
  var body = line(kind, from, opts);
  return opts.url ? (body + '\n' + opts.url) : body;
}

function whatsapp(kind, from, opts) {
  return 'https://wa.me/?text=' + encodeURIComponent(message(kind, from, opts));
}

return { line: line, message: message, whatsapp: whatsapp,
         TABLES: TABLES, pick: pick };
}));
