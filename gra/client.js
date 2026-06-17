const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const minimap = document.getElementById("minimap");
const mini = minimap.getContext("2d");

const els = {
  joinPanel: document.getElementById("joinPanel"),
  joinButton: document.getElementById("joinButton"),
  registerButton: document.getElementById("registerButton"),
  loginName: document.getElementById("loginName"),
  loginPassword: document.getElementById("loginPassword"),
  nationName: document.getElementById("nationName"),
  nationColor: document.getElementById("nationColor"),
  playerName: document.getElementById("playerName"),
  connection: document.getElementById("connection"),
  points: document.getElementById("points"),
  strength: document.getElementById("strength"),
  tiles: document.getElementById("tiles"),
  leaderboard: document.getElementById("leaderboard"),
  strengthLeaderboard: document.getElementById("strengthLeaderboard"),
  alliances: document.getElementById("alliances"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  actionMenu: document.getElementById("actionMenu"),
  targetName: document.getElementById("targetName"),
  mobileMenuButton: document.getElementById("mobileMenuButton"),
  pauseMenu: document.getElementById("pauseMenu"),
  resumeButton: document.getElementById("resumeButton"),
  centerButton: document.getElementById("centerButton"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  saveButton: document.getElementById("saveButton"),
  restartButton: document.getElementById("restartButton"),
  toastStack: document.getElementById("toastStack"),
};

const state = {
  socket: null,
  playerId: null,
  players: new Map(),
  cells: new Map(),
  view: { x: -120, y: -70, scale: 20 },
  mouse: { x: 0, y: 0, worldX: 0, worldY: 0 },
  hoveredCell: null,
  selectedCell: null,
  dragging: false,
  dragButton: 0,
  touch: {
    active: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    pinchDistance: 0,
  },
  space: false,
};

const savedName = localStorage.getItem("pixelNationName");
const savedColor = localStorage.getItem("pixelNationColor");
const savedLogin = localStorage.getItem("pixelLoginName");
if (savedName) els.nationName.value = savedName;
if (savedColor) els.nationColor.value = savedColor;
if (savedLogin) els.loginName.value = savedLogin;

function key(x, y) {
  return `${x},${y}`;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function screenToWorld(x, y) {
  return {
    x: Math.floor((x - state.view.x) / state.view.scale),
    y: Math.floor((y - state.view.y) / state.view.scale),
  };
}

function worldToScreen(x, y) {
  return {
    x: state.view.x + x * state.view.scale,
    y: state.view.y + y * state.view.scale,
  };
}

function isAdjacentToOwnCell(x, y) {
  const me = state.players.get(state.playerId);
  if (!me || me.tiles <= 0) return true;
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].some(([nx, ny]) => {
    const cell = state.cells.get(key(nx, ny));
    return cell && cell.owner === state.playerId;
  });
}

function centerOnOwnNation() {
  const ownCells = [...state.cells.values()].filter((cell) => cell.owner === state.playerId);
  if (!ownCells.length) return;
  const avgX = ownCells.reduce((sum, cell) => sum + cell.x, 0) / ownCells.length;
  const avgY = ownCells.reduce((sum, cell) => sum + cell.y, 0) / ownCells.length;
  state.view.x = innerWidth / 2 - (avgX + .5) * state.view.scale;
  state.view.y = innerHeight / 2 - (avgY + .5) * state.view.scale;
}

function setPauseMenu(open) {
  els.pauseMenu.classList.toggle("hidden", !open);
  if (open) hideActionMenu();
}

function zoomAt(clientX, clientY, nextScale) {
  const oldScale = state.view.scale;
  const scale = Math.max(4, Math.min(52, nextScale));
  const wx = (clientX - state.view.x) / oldScale;
  const wy = (clientY - state.view.y) / oldScale;
  state.view.scale = scale;
  state.view.x = clientX - wx * scale;
  state.view.y = clientY - wy * scale;
  updateHover();
}

function handleBoardTap(clientX, clientY) {
  if (!els.pauseMenu.classList.contains("hidden")) return;
  hideActionMenu();
  const world = screenToWorld(clientX, clientY);
  const cell = state.cells.get(key(world.x, world.y));
  if (cell && cell.owner) {
    openActionMenu(cell, clientX, clientY);
    return;
  }
  if (!isAdjacentToOwnCell(world.x, world.y)) {
    toast("Możesz malować tylko piksele stykające się bokiem z twoim państwem.");
    return;
  }
  send("paint", { x: world.x, y: world.y });
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const host = location.protocol === "file:" ? "localhost:3000" : location.host;
  state.socket = new WebSocket(`${protocol}://${host}`);
  state.socket.addEventListener("open", () => {
    els.connection.textContent = "online";
  });
  state.socket.addEventListener("close", () => {
    els.connection.textContent = "rozłączono, ponawiam...";
    setTimeout(connect, 1200);
  });
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });
}

function send(type, data = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type, ...data }));
}

function handleMessage(message) {
  if (message.type === "welcome") {
    hydrate(message);
  }
  if (message.type === "state") {
    if (message.id) state.playerId = message.id;
    hydrate(message);
  }
  if (message.type === "player") {
    state.players.set(message.player.id, message.player);
    renderUi();
  }
  if (message.type === "playerLeft") {
    const player = state.players.get(message.id);
    if (player) player.online = false;
    renderUi();
  }
  if (message.type === "playerRemoved") {
    state.players.delete(message.id);
    for (const player of state.players.values()) {
      player.allies = (player.allies || []).filter((id) => id !== message.id);
    }
    renderUi();
  }
  if (message.type === "cell") {
    if (message.cell) state.cells.set(key(message.cell.x, message.cell.y), message.cell);
    renderUi();
  }
  if (message.type === "removeCells") {
    for (const cellKey of message.keys) state.cells.delete(cellKey);
    renderUi();
  }
  if (message.type === "cells") {
    for (const cell of message.cells) state.cells.set(key(cell.x, cell.y), cell);
    renderUi();
  }
  if (message.type === "chat") addChat(message);
  if (message.type === "notice") toast(message.text);
  if (message.type === "joinRejected") {
    toast(message.text);
    els.joinPanel.classList.remove("hidden");
  }
  if (message.type === "allyRequest") showAllianceRequest(message);
}

function hydrate(message) {
  state.players = new Map(message.players.map((player) => [player.id, player]));
  state.cells = new Map(message.cells.map((cell) => [key(cell.x, cell.y), cell]));
  renderUi();
}

function joinGame(mode = "login") {
  const login = els.loginName.value.trim().toLocaleLowerCase("pl-PL").replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  const password = els.loginPassword.value;
  if (login.length < 3) {
    toast("Podaj login, minimum 3 znaki.");
    return;
  }
  if (password.length < 4) {
    toast("Podaj hasło, minimum 4 znaki.");
    return;
  }
  const name = els.nationName.value.trim().slice(0, 24);
  if (mode === "register" && !name) {
    toast("Podaj nazwę.");
    return;
  }
  const color = els.nationColor.value;
  els.loginName.value = login;
  localStorage.setItem("pixelLoginName", login);
  if (mode === "register") {
    localStorage.setItem("pixelNationName", name);
    localStorage.setItem("pixelNationColor", color);
  }
  els.joinPanel.classList.add("hidden");
  send("join", { mode, login, password, name, color });
}

function renderUi() {
  const me = state.players.get(state.playerId);
  if (me) {
    els.playerName.textContent = me.name;
    els.points.textContent = me.points;
    els.strength.textContent = me.strength;
    els.tiles.textContent = me.tiles;
  }

  const activePlayers = [...state.players.values()].filter((player) => !player.conqueredBy);
  const players = activePlayers.sort((a, b) => b.tiles - a.tiles || b.strength - a.strength);
  els.leaderboard.innerHTML = players.map((player) => {
    const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${player.color};margin-right:6px"></span>`;
    const conqueror = player.conqueredBy ? state.players.get(player.conqueredBy) : null;
    const status = conqueror ? ` · podbite przez ${escapeHtml(conqueror.name)}` : player.online ? "" : " · offline";
    return `<li>${dot}${escapeHtml(player.name)} <b>${player.tiles}</b>${status}</li>`;
  }).join("");

  const strengthPlayers = activePlayers.sort((a, b) => b.strength - a.strength || b.tiles - a.tiles);
  els.strengthLeaderboard.innerHTML = strengthPlayers.map((player) => {
    const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${player.color};margin-right:6px"></span>`;
    return `<li>${dot}${escapeHtml(player.name)} <b>${player.strength}</b></li>`;
  }).join("");

  if (!me || !me.allies.length) {
    els.alliances.className = "empty";
    els.alliances.textContent = "Brak sojuszy";
  } else {
    els.alliances.className = "";
    els.alliances.innerHTML = me.allies.map((id) => {
      const player = state.players.get(id);
      return player ? `
        <div class="alliance-row">
          <span style="color:${player.color}">${escapeHtml(player.name)}</span>
          <button data-break-alliance="${escapeHtml(player.id)}">Zerwij</button>
        </div>
      ` : "";
    }).join("");
  }
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  drawGrid();
  drawCells();
  drawHover();
  drawMiniMap();
  requestAnimationFrame(draw);
}

function drawGrid() {
  const s = state.view.scale;
  if (s < 5) return;
  const startX = Math.floor(-state.view.x / s) - 1;
  const endX = Math.ceil((innerWidth - state.view.x) / s) + 1;
  const startY = Math.floor(-state.view.y / s) - 1;
  const endY = Math.ceil((innerHeight - state.view.y) / s) + 1;
  ctx.strokeStyle = s > 14 ? "rgba(255,255,255,.07)" : "rgba(255,255,255,.035)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= endX; x++) {
    const sx = Math.round(state.view.x + x * s) + .5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, innerHeight);
  }
  for (let y = startY; y <= endY; y++) {
    const sy = Math.round(state.view.y + y * s) + .5;
    ctx.moveTo(0, sy);
    ctx.lineTo(innerWidth, sy);
  }
  ctx.stroke();
}

function drawCells() {
  const s = state.view.scale;
  const pad = s > 12 ? 1 : 0;
  for (const cell of state.cells.values()) {
    const pos = worldToScreen(cell.x, cell.y);
    if (pos.x < -s || pos.y < -s || pos.x > innerWidth || pos.y > innerHeight) continue;
    const owner = state.players.get(cell.owner);
    ctx.fillStyle = owner ? owner.color : cell.color;
    ctx.globalAlpha = owner && owner.online ? 1 : .55;
    ctx.fillRect(pos.x + pad, pos.y + pad, Math.max(1, s - pad * 2), Math.max(1, s - pad * 2));
    ctx.globalAlpha = 1;
    const defenseLevel = Number(cell.defenseLevel) || 0;
    if (defenseLevel > 0 && s >= 10) {
      ctx.strokeStyle = "rgba(255,255,255,.82)";
      ctx.lineWidth = Math.max(1, Math.min(4, defenseLevel / 3));
      ctx.strokeRect(pos.x + pad + 2, pos.y + pad + 2, Math.max(1, s - pad * 2 - 4), Math.max(1, s - pad * 2 - 4));
      if (s >= 18) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(defenseLevel, pos.x + s / 2, pos.y + s / 2 + 4);
        ctx.textAlign = "left";
      }
    }
  }
}

function drawHover() {
  const cell = state.hoveredCell;
  if (!cell) return;
  const pos = worldToScreen(cell.x, cell.y);
  const owner = state.players.get(cell.owner);
  const me = state.players.get(state.playerId);
  const isOther = owner && owner.id !== state.playerId;
  const canPaintHere = !owner && isAdjacentToOwnCell(cell.x, cell.y);
  const defenseLevel = Number(cell.defenseLevel) || 0;
  ctx.lineWidth = isOther ? 4 : 2;
  ctx.strokeStyle = owner ? "#ffffff" : canPaintHere ? "#8ee6ff" : "#f87171";
  ctx.strokeRect(pos.x + 2, pos.y + 2, state.view.scale - 4, state.view.scale - 4);
  if (owner) {
    const title = owner.id === state.playerId ? "Twój piksel" : owner.name;
    const suffix = defenseLevel > 0 ? ` | Wzmocnienie ${defenseLevel}/10` : " | Bez wzmocnienia";
    const text = title + suffix;
    ctx.fillStyle = "rgba(0,0,0,.72)";
    ctx.fillRect(pos.x, pos.y - 30, Math.max(170, text.length * 7 + 18), 24);
    ctx.fillStyle = me && me.allies.includes(owner.id) ? "#9ef3b0" : "#ffffff";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(text, pos.x + 8, pos.y - 13);
  }
}

function drawMiniMap() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = minimap.clientWidth || 180;
  const cssHeight = minimap.clientHeight || 120;
  const pixelWidth = Math.floor(cssWidth * dpr);
  const pixelHeight = Math.floor(cssHeight * dpr);
  if (minimap.width !== pixelWidth || minimap.height !== pixelHeight) {
    minimap.width = pixelWidth;
    minimap.height = pixelHeight;
  }
  mini.setTransform(dpr, 0, 0, dpr, 0, 0);
  mini.clearRect(0, 0, cssWidth, cssHeight);
  mini.fillStyle = "#11131a";
  mini.fillRect(0, 0, cssWidth, cssHeight);
  if (!state.cells.size) return;
  const cells = [...state.cells.values()];
  const viewMin = screenToWorld(0, 0);
  const viewMax = screenToWorld(innerWidth, innerHeight);
  const xs = cells.map((cell) => cell.x).concat([viewMin.x, viewMax.x]);
  const ys = cells.map((cell) => cell.y).concat([viewMin.y, viewMax.y]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX + 1);
  const spanY = Math.max(1, maxY - minY + 1);
  const pad = 6;
  const mapX = (x) => ((x - minX) / spanX) * (cssWidth - pad * 2) + pad;
  const mapY = (y) => ((y - minY) / spanY) * (cssHeight - pad * 2) + pad;
  for (const cell of cells) {
    const owner = state.players.get(cell.owner);
    mini.fillStyle = owner ? owner.color : cell.color;
    mini.fillRect(Math.round(mapX(cell.x)), Math.round(mapY(cell.y)), 3, 3);
  }
  const vx = mapX(viewMin.x);
  const vy = mapY(viewMin.y);
  const vw = mapX(viewMax.x) - vx;
  const vh = mapY(viewMax.y) - vy;
  mini.strokeStyle = "rgba(255,255,255,.85)";
  mini.lineWidth = 1;
  mini.strokeRect(vx, vy, vw, vh);
}

function updateHover() {
  const world = screenToWorld(state.mouse.x, state.mouse.y);
  state.mouse.worldX = world.x;
  state.mouse.worldY = world.y;
  state.hoveredCell = state.cells.get(key(world.x, world.y)) || { x: world.x, y: world.y, owner: null };
}

function openActionMenu(cell, x, y) {
  const owner = state.players.get(cell.owner);
  if (!owner) return;
  const me = state.players.get(state.playerId);
  const allied = Boolean(me && me.allies.includes(owner.id));
  const isOwn = owner.id === state.playerId;
  const defenseLevel = Number(cell.defenseLevel) || 0;
  const nextCost = (defenseLevel + 1) * 5;
  state.selectedCell = cell;
  els.targetName.textContent = isOwn
    ? `Twój piksel | Wzmocnienie ${defenseLevel}/10`
    : `${owner.name} | Wzmocnienie ${defenseLevel}/10`;
  const allyButton = els.actionMenu.querySelector('[data-action="ally"]');
  const breakButton = els.actionMenu.querySelector('[data-action="breakAlliance"]');
  const attackButton = els.actionMenu.querySelector('[data-action="attack"]');
  const upgradeButton = els.actionMenu.querySelector('[data-action="upgrade"]');
  const giftButton = els.actionMenu.querySelector('[data-action="gift"]');
  allyButton.style.display = !isOwn && !allied ? "" : "none";
  breakButton.style.display = !isOwn && allied ? "" : "none";
  attackButton.style.display = !isOwn && !allied ? "" : "none";
  upgradeButton.style.display = isOwn ? "" : "none";
  upgradeButton.textContent = defenseLevel >= 10 ? "Maksymalne wzmocnienie" : `Wzmocnij za ${nextCost} pkt`;
  giftButton.style.display = isOwn ? "none" : "";
  els.actionMenu.style.left = `${Math.min(x, innerWidth - 230)}px`;
  els.actionMenu.style.top = `${Math.min(y, innerHeight - 220)}px`;
  els.actionMenu.classList.remove("hidden");
}

function hideActionMenu() {
  els.actionMenu.classList.add("hidden");
}

function toast(text, actions = []) {
  const box = document.createElement("div");
  box.className = "toast";
  box.textContent = text;
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "toast-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", () => {
        action.run();
        box.remove();
      });
      row.appendChild(button);
    }
    box.appendChild(row);
  }
  els.toastStack.appendChild(box);
  setTimeout(() => box.remove(), actions.length ? 15000 : 4200);
}

function showAllianceRequest(message) {
  toast(`${message.fromName} proponuje sojusz.`, [
    { label: "Akceptuj", run: () => send("allyResponse", { from: message.from, accepted: true }) },
    { label: "Odrzuć", run: () => send("allyResponse", { from: message.from, accepted: false }) },
  ]);
}

function addChat(message) {
  if (!els.chatLog) return;
  const line = document.createElement("div");
  line.className = "chat-line";
  line.innerHTML = `<b style="color:${message.color || "#fff"}">${escapeHtml(message.name || "System")}:</b> ${escapeHtml(message.text)}`;
  els.chatLog.appendChild(line);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

els.joinButton.addEventListener("click", () => joinGame("login"));
els.registerButton.addEventListener("click", () => joinGame("register"));
els.loginName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinGame("login");
});
els.loginPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinGame("login");
});
els.nationName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinGame("register");
});

if (els.chatForm) {
  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    send("chat", { text });
    els.chatInput.value = "";
  });
}

els.alliances.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-break-alliance]");
  if (!button) return;
  send("breakAlliance", { target: button.dataset.breakAlliance });
});

els.actionMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.selectedCell) return;
  const target = state.selectedCell.owner;
  if (button.dataset.action === "ally") send("allyRequest", { target });
  if (button.dataset.action === "breakAlliance") send("breakAlliance", { target });
  if (button.dataset.action === "attack") send("attack", { x: state.selectedCell.x, y: state.selectedCell.y });
  if (button.dataset.action === "upgrade") send("upgrade", { x: state.selectedCell.x, y: state.selectedCell.y });
  if (button.dataset.action === "gift") send("gift", { target });
  if (button.dataset.action === "message") {
    const player = state.players.get(target);
    if (els.chatInput) {
      els.chatInput.value = player ? `@${player.name} ` : "";
      els.chatInput.focus();
    }
  }
  hideActionMenu();
});

els.resumeButton.addEventListener("click", () => setPauseMenu(false));
els.mobileMenuButton.addEventListener("click", () => {
  setPauseMenu(els.pauseMenu.classList.contains("hidden"));
});
els.centerButton.addEventListener("click", () => {
  centerOnOwnNation();
  setPauseMenu(false);
});
els.zoomInButton.addEventListener("click", () => {
  zoomAt(innerWidth / 2, innerHeight / 2, state.view.scale * 1.2);
});
els.zoomOutButton.addEventListener("click", () => {
  zoomAt(innerWidth / 2, innerHeight / 2, state.view.scale / 1.2);
});
els.saveButton.addEventListener("click", () => {
  send("save");
  setPauseMenu(false);
});
els.restartButton.addEventListener("click", () => {
  if (!confirm("Zrestartować grę?")) return;
  send("restart");
  els.joinPanel.classList.remove("hidden");
  setPauseMenu(false);
});

els.pauseMenu.addEventListener("click", (event) => {
  if (event.target === els.pauseMenu) setPauseMenu(false);
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("mousemove", (event) => {
  if (state.dragging) {
    state.view.x += event.movementX;
    state.view.y += event.movementY;
  }
  state.mouse.x = event.clientX;
  state.mouse.y = event.clientY;
  updateHover();
});

canvas.addEventListener("mousedown", (event) => {
  if (!els.pauseMenu.classList.contains("hidden")) return;
  hideActionMenu();
  state.dragButton = event.button;
  if (event.button === 2 || state.space) {
    state.dragging = true;
    return;
  }
  const world = screenToWorld(event.clientX, event.clientY);
  const cell = state.cells.get(key(world.x, world.y));
  if (cell && cell.owner) {
    openActionMenu(cell, event.clientX, event.clientY);
  } else {
    handleBoardTap(event.clientX, event.clientY);
  }
});

canvas.addEventListener("touchstart", (event) => {
  event.preventDefault();
  hideActionMenu();
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    state.touch.active = true;
    state.touch.moved = false;
    state.touch.startX = touch.clientX;
    state.touch.startY = touch.clientY;
    state.touch.lastX = touch.clientX;
    state.touch.lastY = touch.clientY;
    state.mouse.x = touch.clientX;
    state.mouse.y = touch.clientY;
    updateHover();
  }
  if (event.touches.length === 2) {
    state.touch.active = true;
    state.touch.moved = true;
    state.touch.pinchDistance = touchDistance(event.touches);
  }
}, { passive: false });

canvas.addEventListener("touchmove", (event) => {
  event.preventDefault();
  if (event.touches.length === 1 && state.touch.active) {
    const touch = event.touches[0];
    const dx = touch.clientX - state.touch.lastX;
    const dy = touch.clientY - state.touch.lastY;
    if (Math.hypot(touch.clientX - state.touch.startX, touch.clientY - state.touch.startY) > 8) {
      state.touch.moved = true;
    }
    state.view.x += dx;
    state.view.y += dy;
    state.touch.lastX = touch.clientX;
    state.touch.lastY = touch.clientY;
    state.mouse.x = touch.clientX;
    state.mouse.y = touch.clientY;
    updateHover();
  }
  if (event.touches.length === 2) {
    const distance = touchDistance(event.touches);
    const center = touchCenter(event.touches);
    if (state.touch.pinchDistance > 0) {
      zoomAt(center.x, center.y, state.view.scale * (distance / state.touch.pinchDistance));
    }
    state.touch.pinchDistance = distance;
  }
}, { passive: false });

canvas.addEventListener("touchend", (event) => {
  event.preventDefault();
  if (event.touches.length > 0) return;
  const wasTap = state.touch.active && !state.touch.moved;
  const x = state.touch.lastX;
  const y = state.touch.lastY;
  state.touch.active = false;
  state.touch.pinchDistance = 0;
  if (wasTap) handleBoardTap(x, y);
}, { passive: false });

window.addEventListener("mouseup", () => {
  state.dragging = false;
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") state.space = true;
  if (event.key === "Escape") {
    event.preventDefault();
    const isMenuOpen = !els.pauseMenu.classList.contains("hidden");
    if (!els.actionMenu.classList.contains("hidden")) {
      hideActionMenu();
      return;
    }
    setPauseMenu(!isMenuOpen);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") state.space = false;
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomAt(event.clientX, event.clientY, state.view.scale * (event.deltaY > 0 ? .9 : 1.1));
}, { passive: false });

window.addEventListener("resize", resize);
resize();
connect();
draw();
