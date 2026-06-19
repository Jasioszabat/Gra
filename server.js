const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SAVE_FILE = process.env.SAVE_FILE || path.join(process.env.DATA_DIR || ROOT, "world-save.json");

const sockets = new Map();
const socketPlayers = new Map();
const playerSockets = new Map();
const players = new Map();
const cells = new Map();
const MAX_DEFENSE_LEVEL = 10;
let saveTimer = null;
let saving = false;
let saveAgain = false;

function cellKey(x, y) {
  return `${x},${y}`;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    points: player.points,
    strength: player.strength,
    tiles: player.tiles,
    allies: [...player.allies],
    online: player.online,
    conqueredBy: player.conqueredBy,
  };
}

function publicCell(cell) {
  return {
    x: cell.x,
    y: cell.y,
    owner: cell.owner,
    color: cell.color,
    defenseLevel: Math.max(0, Math.min(MAX_DEFENSE_LEVEL, Number(cell.defenseLevel) || 0)),
  };
}

function saveWorld() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushWorldSave, 15000);
}

function flushWorldSave() {
  saveTimer = null;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  const activePlayers = [...players.values()].filter((player) => !player.conqueredBy && player.tiles > 0);
  const activePlayerIds = new Set(activePlayers.map((player) => player.id));
  const data = {
    players: activePlayers.map((player) => ({
      ...publicPlayer(player),
      login: player.login || null,
      passwordSalt: player.passwordSalt || null,
      passwordHash: player.passwordHash || null,
      online: false,
    })),
    cells: [...cells.values()].filter((cell) => activePlayerIds.has(cell.owner)).map(publicCell),
  };
  const tempFile = `${SAVE_FILE}.tmp`;
  fs.mkdir(path.dirname(SAVE_FILE), { recursive: true }, () => {
    fs.writeFile(tempFile, JSON.stringify(data, null, 2), (writeError) => {
      if (writeError) {
        saving = false;
        console.log("Nie udalo sie zapisac swiata.");
        return;
      }
      fs.rename(tempFile, SAVE_FILE, () => {
        saving = false;
        if (saveAgain) {
          saveAgain = false;
          saveWorld();
        }
      });
    });
  });
}

function saveWorldNow() {
  const activePlayers = [...players.values()].filter((player) => !player.conqueredBy && player.tiles > 0);
  const activePlayerIds = new Set(activePlayers.map((player) => player.id));
  const data = {
    players: activePlayers.map((player) => ({
      ...publicPlayer(player),
      login: player.login || null,
      passwordSalt: player.passwordSalt || null,
      passwordHash: player.passwordHash || null,
      online: false,
    })),
    cells: [...cells.values()].filter((cell) => activePlayerIds.has(cell.owner)).map(publicCell),
  };
  fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
  fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2));
}

function loadWorld() {
  if (!fs.existsSync(SAVE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const player of data.players || []) {
      if (player.conqueredBy || Number(player.tiles) <= 0) continue;
      players.set(player.id, {
        id: player.id,
        name: player.name,
        color: player.color,
        points: Number(player.points) || 0,
        strength: Number(player.strength) || 1,
        tiles: Number(player.tiles) || 0,
        allies: new Set(player.allies || []),
        online: false,
        conqueredBy: player.conqueredBy || null,
        login: player.login || null,
        passwordSalt: player.passwordSalt || null,
        passwordHash: player.passwordHash || null,
      });
    }
    for (const cell of data.cells || []) {
      if (!players.has(cell.owner)) continue;
      cells.set(cellKey(cell.x, cell.y), publicCell(cell));
    }
  } catch {
    console.log("Nie udalo sie wczytac zapisu swiata.");
  }
}

function removePlayerCells(playerId) {
  const removed = [];
  for (const [id, cell] of cells.entries()) {
    if (cell.owner === playerId) {
      cells.delete(id);
      removed.push(id);
    }
  }
  if (removed.length) broadcast({ type: "removeCells", keys: removed });
  if (removed.length) saveWorld();
  return removed.length;
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const socket of sockets.values()) sendFrame(socket, data);
}

function sendTo(id, message) {
  const socket = playerSockets.get(id);
  if (socket) sendFrame(socket, JSON.stringify(message));
}

function sendToConnection(id, message) {
  const socket = sockets.get(id);
  if (socket) sendFrame(socket, JSON.stringify(message));
}

function notice(id, text) {
  sendTo(id, { type: "notice", text });
}

function updatePlayer(player) {
  broadcast({ type: "player", player: publicPlayer(player) });
}

function randomSpawn() {
  for (let i = 0; i < 500; i++) {
    const x = Math.floor(Math.random() * 21) - 10;
    const y = Math.floor(Math.random() * 21) - 10;
    if (!cells.has(cellKey(x, y))) return { x, y };
  }
  return { x: Date.now() % 1000, y: Math.floor(Date.now() / 1000) % 1000 };
}

function isAdjacentToOwnedCell(player, x, y) {
  if (player.tiles <= 0) return true;
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].some(([nx, ny]) => {
    const cell = cells.get(cellKey(nx, ny));
    return cell && cell.owner === player.id;
  });
}

function isNameOrColorTaken(name, color, exceptId) {
  const normalizedName = name.toLocaleLowerCase("pl-PL");
  const normalizedColor = color.toLowerCase();
  return [...players.values()].some((player) =>
    player.id !== exceptId &&
    (
      player.name.toLocaleLowerCase("pl-PL") === normalizedName ||
      player.color.toLowerCase() === normalizedColor
    )
  );
}

function joinPlayer(id, data) {
  const oldPlayer = players.get(id);
  const name = cleanText(data.name, 24) || "Gra";
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : "#22c55e";
  if (isNameOrColorTaken(name, color, id)) {
    sendTo(id, { type: "joinRejected", text: "Ta nazwa albo kolor są już zajęte." });
    return;
  }
  if (oldPlayer) {
    removePlayerCells(id);
    for (const player of players.values()) player.allies.delete(id);
  }
  const spawn = randomSpawn();
  const player = {
    id,
    name,
    color,
    points: 5,
    strength: 1,
    tiles: 0,
    allies: new Set(),
    online: true,
    conqueredBy: null,
  };
  players.set(id, player);
  paintCell(player, spawn.x, spawn.y, true);
  broadcast({ type: "player", player: publicPlayer(player) });
  sendToConnection(id, {
    type: "state",
    players: [...players.values()].map(publicPlayer),
    cells: [...cells.values()].map(publicCell),
  });
  broadcast({
    type: "chat",
    name: "System",
    color: "#8ee6ff",
    text: `${player.name} dołącza do gry.`,
  });
  saveWorld();
}

function cleanLogin(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("pl-PL")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

function accountIdFromLogin(login) {
  return crypto.createHash("sha256").update(`pixel-account:${login}`).digest("hex").slice(0, 16);
}

function passwordDigest(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}

function setPassword(player, password) {
  player.passwordSalt = crypto.randomBytes(16).toString("hex");
  player.passwordHash = passwordDigest(password, player.passwordSalt);
}

function isPasswordValid(player, password) {
  if (!player.passwordSalt || !player.passwordHash) return false;
  const hash = passwordDigest(password, player.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(player.passwordHash, "hex"));
}

function findPlayerForJoin(login, name, color) {
  const byLogin = [...players.values()].find((player) => player.login === login);
  if (byLogin) return byLogin;
  const normalizedName = name.toLocaleLowerCase("pl-PL");
  const normalizedColor = color.toLowerCase();
  return [...players.values()].find((player) => {
    if (player.login) return false;
    return (
      player.name.toLocaleLowerCase("pl-PL") === login ||
      player.name.toLocaleLowerCase("pl-PL") === normalizedName ||
      player.color.toLowerCase() === normalizedColor
    );
  });
}

function attachPlayerToSocket(connectionId, player) {
  const socket = sockets.get(connectionId);
  if (!socket) return;
  for (const [otherConnectionId, playerId] of socketPlayers.entries()) {
    if (playerId === player.id && otherConnectionId !== connectionId) {
      const oldSocket = sockets.get(otherConnectionId);
      if (oldSocket) oldSocket.destroy();
      sockets.delete(otherConnectionId);
      socketPlayers.delete(otherConnectionId);
    }
  }
  socketPlayers.set(connectionId, player.id);
  playerSockets.set(player.id, socket);
}

function joinPlayer(connectionId, data) {
  const login = cleanLogin(data.login);
  const password = String(data.password || "");
  const mode = data.mode === "register" ? "register" : "login";
  if (login.length < 3) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Login musi miec minimum 3 znaki." });
    return;
  }
  if (password.length < 4) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Haslo musi miec minimum 4 znaki." });
    return;
  }

  const requestedName = cleanText(data.name, 24);
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : "#22c55e";
  let player = mode === "register"
    ? findPlayerForJoin(login, requestedName || login, color)
    : [...players.values()].find((savedPlayer) => savedPlayer.login === login);
  const isNewAccount = !player;
  const name = requestedName || (player ? player.name : login);

  if (mode === "login" && !player) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Nie ma takiego konta. Uzyj rejestracji." });
    return;
  }
  if (mode === "register" && !requestedName) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Podaj nazwe panstwa." });
    return;
  }
  if (mode === "register" && player && player.login === login) {
    sendToConnection(connectionId, { type: "joinRejected", text: "To konto juz istnieje. Uzyj logowania." });
    return;
  }

  if (player && player.passwordHash && !isPasswordValid(player, password)) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Nieprawidlowy login albo haslo." });
    return;
  }
  if (mode === "register" && isNameOrColorTaken(name, color, player ? player.id : null)) {
    sendToConnection(connectionId, { type: "joinRejected", text: "Ta nazwa albo kolor sa juz zajete." });
    return;
  }

  if (!player) {
    let id = accountIdFromLogin(login);
    while (players.has(id)) id = crypto.randomBytes(8).toString("hex");
    player = {
      id,
      name,
      color,
      points: 5,
      strength: 1,
      tiles: 0,
      allies: new Set(),
      online: true,
      conqueredBy: null,
      login,
      passwordSalt: null,
      passwordHash: null,
    };
    setPassword(player, password);
    players.set(id, player);
    const spawn = randomSpawn();
    paintCell(player, spawn.x, spawn.y, true);
  } else {
    if (!player.passwordHash) setPassword(player, password);
    player.login = login;
    if (mode === "register") {
      player.name = name;
      player.color = color;
    }
    player.online = true;
  }

  attachPlayerToSocket(connectionId, player);
  broadcast({ type: "player", player: publicPlayer(player) });
  sendTo(player.id, {
    type: "state",
    id: player.id,
    players: [...players.values()].map(publicPlayer),
    cells: [...cells.values()].map(publicCell),
  });
  if (isNewAccount) {
    broadcast({
      type: "chat",
      name: "System",
      color: "#8ee6ff",
      text: `${player.name} dolacza do gry.`,
    });
  }
  saveWorld();
}

function restartPlayer(id) {
  const player = players.get(id);
  if (!player) return;
  removePlayerCells(id);
  for (const other of players.values()) {
    other.allies.delete(id);
    updatePlayer(other);
  }
  player.points = 5;
  player.strength = 1;
  player.tiles = 0;
  player.allies = new Set();
  player.conqueredBy = null;
  const spawn = randomSpawn();
  paintCell(player, spawn.x, spawn.y, true);
  sendToConnection(id, {
    type: "state",
    id,
    players: [...players.values()].map(publicPlayer),
    cells: [...cells.values()].map(publicCell),
  });
  broadcast({
    type: "chat",
    name: "System",
    color: "#8ee6ff",
    text: `${player.name} restartuje państwo.`,
  });
  saveWorld();
}

function paintCell(player, x, y, free = false) {
  if (!free && player.conqueredBy) {
    notice(player.id, "Twoje państwo jest podbite. Odśwież stronę, żeby zacząć nowe państwo.");
    return;
  }
  x = Math.trunc(Number(x));
  y = Math.trunc(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const id = cellKey(x, y);
  const existing = cells.get(id);
  if (existing && existing.owner !== player.id) {
    notice(player.id, "Ten piksel należy do innego państwa. Kliknij go i wybierz akcję.");
    return;
  }
  if (existing && existing.owner === player.id) {
    notice(player.id, "Ten piksel już jest twój.");
    return;
  }
  if (!free && !isAdjacentToOwnedCell(player, x, y)) {
    notice(player.id, "Możesz malować tylko piksele stykające się bokiem z twoim państwem.");
    return;
  }
  if (!free && player.points < 1) {
    notice(player.id, "Brakuje punktu do zamalowania piksela.");
    return;
  }
  if (!free) player.points -= 1;
  player.tiles += 1;
  player.strength += 1;
  const cell = { x, y, owner: player.id, color: player.color, defenseLevel: 0 };
  cells.set(id, cell);
  broadcast({ type: "cell", cell: publicCell(cell) });
  updatePlayer(player);
  saveWorld();
}

function upgradeCell(player, x, y) {
  if (player.conqueredBy) {
    notice(player.id, "Twoje państwo jest podbite i nie może wzmacniać pikseli.");
    return;
  }
  x = Math.trunc(Number(x));
  y = Math.trunc(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const cell = cells.get(cellKey(x, y));
  if (!cell || cell.owner !== player.id) {
    notice(player.id, "Możesz wzmacniać tylko własne piksele.");
    return;
  }
  const level = Math.max(0, Number(cell.defenseLevel) || 0);
  if (level >= MAX_DEFENSE_LEVEL) {
    notice(player.id, "Ten piksel ma już maksymalne wzmocnienie.");
    return;
  }
  const cost = (level + 1) * 5;
  if (player.points < cost) {
    notice(player.id, `Wzmocnienie na poziom ${level + 1} kosztuje ${cost} punktów.`);
    return;
  }
  player.points -= cost;
  cell.defenseLevel = level + 1;
  broadcast({ type: "cell", cell: publicCell(cell) });
  updatePlayer(player);
  notice(player.id, `Wzmocniono piksel do poziomu ${cell.defenseLevel}.`);
  saveWorld();
}

function conquerPlayer(attacker, defender) {
  for (const player of players.values()) {
    player.allies.delete(defender.id);
  }
  attacker.points += 10;
  attacker.strength += 5;
  broadcast({
    type: "chat",
    name: "System",
    color: "#8ee6ff",
    text: `${attacker.name} podbija państwo ${defender.name}.`,
  });
  notice(attacker.id, `Podbijasz państwo ${defender.name}. Bonus: +10 punktów i +5 siły.`);
  notice(defender.id, `${attacker.name} podbija twoje państwo.`);
  const defenderSocket = playerSockets.get(defender.id);
  if (defenderSocket) defenderSocket.destroy();
  for (const [connectionId, playerId] of socketPlayers.entries()) {
    if (playerId === defender.id) socketPlayers.delete(connectionId);
  }
  playerSockets.delete(defender.id);
  players.delete(defender.id);
  broadcast({ type: "playerRemoved", id: defender.id });
  updatePlayer(attacker);
  saveWorld();
}

function attackCell(player, x, y) {
  if (player.conqueredBy) {
    notice(player.id, "Twoje państwo jest podbite i nie może atakować.");
    return;
  }
  x = Math.trunc(Number(x));
  y = Math.trunc(Number(y));
  const targetCell = cells.get(cellKey(x, y));
  if (!targetCell || targetCell.owner === player.id) return;
  const defender = players.get(targetCell.owner);
  if (!defender) return;
  if (player.allies.has(defender.id)) {
    notice(player.id, "Nie możesz atakować sojusznika.");
    return;
  }
  if (!isAdjacentToOwnedCell(player, x, y)) {
    notice(player.id, "Mozesz atakowac tylko piksele stykajace sie bokiem z twoim panstwem.");
    return;
  }
  if (player.points < 3) {
    notice(player.id, "Atak kosztuje 3 punkty.");
    return;
  }
  player.points -= 3;
  const attackPower = player.strength + Math.random() * 8;
  const defensePower = defender.strength + Math.random() * 8;
  if (attackPower >= defensePower) {
    const defenseLevel = Math.max(0, Number(targetCell.defenseLevel) || 0);
    if (defenseLevel > 0) {
      targetCell.defenseLevel = defenseLevel - 1;
      broadcast({ type: "cell", cell: publicCell(targetCell) });
      notice(player.id, `Atak obniża wzmocnienie piksela do poziomu ${targetCell.defenseLevel}.`);
      notice(defender.id, `${player.name} osłabia wzmocnienie twojego piksela.`);
      updatePlayer(player);
      updatePlayer(defender);
      saveWorld();
      return;
    }
    targetCell.owner = player.id;
    targetCell.color = player.color;
    targetCell.defenseLevel = 0;
    player.tiles += 1;
    player.strength += 2;
    defender.tiles = Math.max(0, defender.tiles - 1);
    defender.strength = Math.max(1, defender.strength - 2);
    broadcast({ type: "cell", cell: publicCell(targetCell) });
    notice(player.id, `Wygrany atak na ${defender.name}.`);
    notice(defender.id, `${player.name} zdobywa twój piksel.`);
    if (defender.tiles === 0) {
      conquerPlayer(player, defender);
      saveWorld();
      return;
    }
  } else {
    player.strength = Math.max(1, player.strength - 1);
    defender.strength += 1;
    notice(player.id, `${defender.name} obronił piksel.`);
    notice(defender.id, `Obroniono atak państwa ${player.name}.`);
  }
  updatePlayer(player);
  updatePlayer(defender);
  saveWorld();
}

function handleAllianceRequest(player, targetId) {
  if (player.conqueredBy) {
    notice(player.id, "Podbite państwo nie może proponować sojuszy.");
    return;
  }
  const target = players.get(targetId);
  if (!target || target.id === player.id) return;
  sendTo(target.id, {
    type: "allyRequest",
    from: player.id,
    fromName: player.name,
  });
  notice(player.id, `Wysłano propozycję sojuszu do ${target.name}.`);
}

function handleAllianceResponse(player, fromId, accepted) {
  const other = players.get(fromId);
  if (!other) return;
  if (accepted) {
    player.allies.add(other.id);
    other.allies.add(player.id);
    notice(player.id, `Zawarto sojusz z ${other.name}.`);
    notice(other.id, `${player.name} przyjmuje sojusz.`);
    updatePlayer(player);
    updatePlayer(other);
    saveWorld();
  } else {
    notice(other.id, `${player.name} odrzuca sojusz.`);
  }
}

function breakAlliance(player, targetId) {
  const target = players.get(targetId);
  if (!target || target.id === player.id) return;
  if (!player.allies.has(target.id)) {
    notice(player.id, `Nie masz sojuszu z ${target.name}.`);
    return;
  }
  player.allies.delete(target.id);
  target.allies.delete(player.id);
  notice(player.id, `Zerwano sojusz z ${target.name}.`);
  notice(target.id, `${player.name} zrywa z tobą sojusz.`);
  broadcast({
    type: "chat",
    name: "System",
    color: "#8ee6ff",
    text: `${player.name} zrywa sojusz z ${target.name}.`,
  });
  updatePlayer(player);
  updatePlayer(target);
  saveWorld();
}

function giftPoint(player, targetId, amount = 1) {
  if (player.conqueredBy) {
    notice(player.id, "Podbite państwo nie może przekazywać punktów.");
    return;
  }
  const target = players.get(targetId);
  if (!target || target.id === player.id) return;
  amount = Math.trunc(Number(amount));
  if (!Number.isFinite(amount) || amount < 1) {
    notice(player.id, "Podaj poprawna liczbe punktow.");
    return;
  }
  if (player.points < amount) {
    notice(player.id, "Nie masz tylu punktow do podarowania.");
    return;
  }
  player.points -= amount;
  target.points += amount;
  notice(player.id, `Przekazano ${amount} pkt do ${target.name}.`);
  notice(target.id, `${player.name} przekazuje ci ${amount} pkt.`);
  updatePlayer(player);
  updatePlayer(target);
  saveWorld();
}

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function handleMessage(id, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === "join") return joinPlayer(id, message);
  const playerId = socketPlayers.get(id);
  const player = players.get(playerId);
  if (!player) return;
  if (message.type === "save") {
    saveWorld();
    notice(id, "Świat zapisany.");
    return;
  }
  if (message.type === "restart") return restartPlayer(player.id);
  if (message.type === "paint") paintCell(player, message.x, message.y);
  if (message.type === "attack") attackCell(player, message.x, message.y);
  if (message.type === "upgrade") upgradeCell(player, message.x, message.y);
  if (message.type === "allyRequest") handleAllianceRequest(player, message.target);
  if (message.type === "allyResponse") handleAllianceResponse(player, message.from, Boolean(message.accepted));
  if (message.type === "breakAlliance") breakAlliance(player, message.target);
  if (message.type === "gift") giftPoint(player, message.target, message.amount);
  if (message.type === "chat") {
    const text = cleanText(message.text, 120);
    if (text) broadcast({ type: "chat", name: player.name, color: player.color, text });
  }
}

setInterval(() => {
  for (const player of players.values()) {
    if (!player.online) continue;
    player.points += 1;
    updatePlayer(player);
  }
  saveWorld();
}, 1000);

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  const id = crypto.randomBytes(8).toString("hex");
  sockets.set(id, socket);
  sendToConnection(id, {
    type: "welcome",
    id,
    players: [...players.values()].map(publicPlayer),
    cells: [...cells.values()].map(publicCell),
  });
  socket.on("data", (buffer) => readFrames(buffer, (text) => handleMessage(id, text)));
  socket.on("close", () => leave(id));
  socket.on("error", () => leave(id));
});

function leave(id) {
  const socket = sockets.get(id);
  sockets.delete(id);
  const playerId = socketPlayers.get(id);
  socketPlayers.delete(id);
  const player = players.get(playerId);
  if (!player || !player.online) return;
  if (playerSockets.get(player.id) !== socket) return;
  player.online = false;
  playerSockets.delete(player.id);
  broadcast({ type: "playerLeft", id: player.id });
  updatePlayer(player);
}

function readFrames(buffer, onText) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) return;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) return;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = Boolean(second & 0x80);
    const mask = masked ? buffer.slice(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + length > buffer.length) return;
    let payload = buffer.slice(offset, offset + length);
    offset += length;
    if (masked) {
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    if (opcode === 8) return;
    if (opcode === 1) onText(payload.toString("utf8"));
  }
}

function sendFrame(socket, text) {
  const payload = Buffer.from(text);
  const header = [];
  header.push(0x81);
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 255, payload.length & 255);
  } else {
    header.push(127);
    const high = Math.floor(payload.length / 2 ** 32);
    const low = payload.length >>> 0;
    header.push((high >> 24) & 255, (high >> 16) & 255, (high >> 8) & 255, high & 255);
    header.push((low >> 24) & 255, (low >> 16) & 255, (low >> 8) & 255, low & 255);
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

loadWorld();

process.on("SIGINT", () => {
  saveWorldNow();
  process.exit(0);
});

process.on("SIGTERM", () => {
  saveWorldNow();
  process.exit(0);
});

server.listen(PORT, "0.0.0.0");
