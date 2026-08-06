/**
 * Creates demo profiles so the swipe deck has something in it.
 *
 *   node tools/seed-demo.mjs https://connect.sirony.in
 *   node tools/seed-demo.mjs http://127.0.0.1:8300
 *
 * Every account uses the reserved `.invalid` TLD (RFC 2606), which can never
 * be a real address, so these are unmistakably fake and trivially removable:
 *
 *   DELETE FROM users WHERE email LIKE '%@connect.invalid';
 *
 * Passwords are random and thrown away — nothing signs in as these accounts
 * again. They exist to be swiped at.
 */
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8300';
const DOMAIN = 'connect.invalid';

/* ------------------------------------------------------------ PNG encoder -- */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * A portrait-shaped gradient. Not a face — these are obviously placeholders,
 * which is the point: nobody should mistake a demo card for a real person.
 */
function portrait(hue, w = 720, h = 1000) {
  const buf = Buffer.alloc(w * h * 3);
  const top = hsl(hue, 0.55, 0.45);
  const bottom = hsl((hue + 40) % 360, 0.6, 0.18);
  for (let y = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++) {
      // A soft diagonal band keeps it from looking like a flat colour swatch.
      const band = 0.06 * Math.sin((x / w + t) * Math.PI * 2);
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        buf[i + c] = Math.max(0, Math.min(255,
          Math.round(top[c] + (bottom[c] - top[c]) * t + band * 255)));
      }
    }
  }
  return encodePNG(w, h, buf);
}

/* ------------------------------------------------------------------- data -- */

const PEOPLE = [
  ['Aria', 29, 'Architect, plant hoarder', 'Weekends are long walks and longer coffees. I will absolutely talk your ear off about buildings.', ['hiking', 'architecture', 'coffee'], ['long_term', 'friends']],
  ['Devika', 33, 'Doctor, night owl', 'Looking for someone who argues about films properly. Nights off are rare and well spent.', ['films', 'cooking', 'running'], ['long_term', 'marriage']],
  ['Kabir', 35, 'Chef', 'I will cook, you do the washing up. Fair trade. Ask me about street food.', ['food', 'travel', 'music'], ['casual_dating', 'fun_hangout']],
  ['Noor', 27, 'Illustrator', 'Quiet mornings, loud music, too many sketchbooks. Happiest in a gallery or a bookshop.', ['art', 'books', 'music'], ['long_term', 'friends']],
  ['Rohan', 31, 'Data engineer, climber', 'Weekday desk, weekend rock. Would like someone to belay and split dosas with.', ['climbing', 'hiking', 'food'], ['long_term', 'activity_partners']],
  ['Meera', 26, 'Teacher', 'Board games, bad puns, and an unreasonable number of houseplants.', ['board games', 'gardening', 'books'], ['friends', 'fun_hangout']],
  ['Ishaan', 38, 'Musician', 'Play four instruments badly and one well. Looking for gig company.', ['music', 'films', 'travel'], ['casual_dating', 'friends']],
  ['Priya', 30, 'Vet', 'Will greet your dog before you. Long walks, longer conversations.', ['pets', 'running', 'cooking'], ['long_term', 'marriage']],
  ['Zayn', 28, 'Photographer', 'Chasing light around the city. Early riser, terrible at sitting still.', ['photography', 'travel', 'coffee'], ['fun_hangout', 'activity_partners']],
  ['Ananya', 34, 'Lawyer', 'Reads too much, sleeps too little. Looking for something unhurried.', ['books', 'films', 'yoga'], ['long_term', 'marriage']],
  ['Farhan', 32, 'Cyclist, product manager', 'Weekend century rides, weekday spreadsheets. Bring snacks.', ['cycling', 'food', 'travel'], ['activity_partners', 'friends']],
  ['Leela', 25, 'Dancer', 'Rehearsals most evenings. Free Sundays and always up for a walk.', ['dance', 'music', 'art'], ['casual_dating', 'fun_hangout']],
];

const LOCALITIES = ['Mumbai', 'Bandra, Mumbai', 'Andheri, Mumbai', 'Powai, Mumbai'];

/* ------------------------------------------------------------------- seed -- */

function dobFor(age) {
  const now = new Date();
  // Mid-year birthday keeps the computed age stable whenever this is run.
  return `${now.getUTCFullYear() - age}-06-15`;
}

async function seedOne(person, index) {
  const [name, age, headline, bio, interests, modes] = person;
  const email = `demo.${name.toLowerCase()}@${DOMAIN}`;
  const password = randomBytes(18).toString('base64url');
  const jar = [];

  const capture = (res) => {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const c of raw) jar.push(c.split(';')[0]);
  };
  const cookie = () => jar.join('; ');

  const register = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, dateOfBirth: dobFor(age) }),
  });
  if (register.status === 409) return { name, status: 'already exists' };
  if (!register.ok) return { name, status: `register failed ${register.status}` };
  capture(register);

  // Portrait, so the deck looks like a deck rather than a list of initials.
  const form = new FormData();
  form.append('file', new Blob([portrait((index * 47) % 360)], { type: 'image/png' }), 'p.png');
  const upload = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: { cookie: cookie() },
    body: form,
  });
  const photo = upload.ok ? (await upload.json()).id : null;

  const profile = await fetch(`${BASE}/api/profiles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify({
      kind: 'dating',
      displayName: name,
      headline,
      bio,
      locality: LOCALITIES[index % LOCALITIES.length],
      interests,
      visibility: 'discoverable',
      photoMediaId: photo,
      // Wide open, so a demo profile accepts whoever is testing.
      ageMin: 18,
      ageMax: 99,
      modes,
    }),
  });

  return {
    name,
    status: profile.ok ? (photo ? 'created with photo' : 'created, photo failed') : `profile failed ${profile.status}`,
  };
}

const results = [];
for (const [index, person] of PEOPLE.entries()) {
  results.push(await seedOne(person, index));
}

for (const r of results) console.log(`  ${r.name.padEnd(10)} ${r.status}`);
const ok = results.filter((r) => r.status.startsWith('created')).length;
console.log(`\n${ok}/${PEOPLE.length} demo profiles ready at ${BASE}`);
console.log(`Remove later:  DELETE FROM users WHERE email LIKE '%@${DOMAIN}';`);
