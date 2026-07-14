const socket = io();

const $ = (id) => document.getElementById(id);
const joinPanel = $("joinPanel");
const tablePanel = $("tablePanel");
const selected = new Set();
let state = null;
let previousState = null;
let playOrigins = new Map();
let toastTimer = null;

const phaseName = {
  lobby: "等待开局",
  bury: "扣底",
  change: "改主",
  changeBury: "重扣底",
  play: "出牌中"
};

function nameValue() {
  return $("name").value.trim() || `玩家${Math.floor(Math.random() * 90 + 10)}`;
}

function api(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (!res?.ok) showToast(res?.error || "操作失败");
      resolve(res);
    });
  });
}

function showToast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

$("createBtn").addEventListener("click", async () => {
  const res = await api("createRoom", { name: nameValue() });
  if (res?.ok) $("roomCode").value = res.code;
});

$("soloBtn").addEventListener("click", async () => {
  const created = await api("createRoom", { name: nameValue() });
  if (!created?.ok) return;
  $("roomCode").value = created.code;
  for (let i = 0; i < 3; i += 1) {
    const added = await api("addBot");
    if (!added?.ok) return;
  }
  await api("startGame");
});

$("joinBtn").addEventListener("click", () => {
  api("joinRoom", { code: $("roomCode").value.trim().toUpperCase(), name: nameValue() });
});

$("botBtn").addEventListener("click", () => api("addBot"));
$("startBtn").addEventListener("click", () => api("startGame"));
$("clearBtn").addEventListener("click", () => {
  selected.clear();
  render();
});
$("passBtn").addEventListener("click", () => api("passChange"));
$("changeBtn").addEventListener("click", async () => {
  const res = await api("changeTrump", { ids: [...selected] });
  if (res?.ok) selected.clear();
});
$("buryBtn").addEventListener("click", async () => {
  const ids = [...selected];
  const res = await api("bury", { ids });
  if (res?.ok) selected.clear();
});
$("playBtn").addEventListener("click", async () => {
  const ids = [...selected];
  playOrigins = capturePlayOrigins(ids);
  const res = await api("play", { ids });
  if (res?.ok) selected.clear();
});

socket.on("state", (next) => {
  const prev = state;
  state = next;
  joinPanel.classList.add("hidden");
  tablePanel.classList.remove("hidden");
  render();
  animateTrickArrival(prev, next);
  previousState = next;
});

socket.on("toast", showToast);

function render() {
  if (!state) return;
  $("code").textContent = state.code;
  $("phase").textContent = phaseName[state.phase] || state.phase;
  $("meta").textContent = `主：${trumpName(state.trump.suit)} ${state.trump.level} ｜ 坐庄队：${state.dealerTeam + 1} ｜ 抓分：${state.scores.attackers}`;
  $("score").textContent = `级数 队1 ${state.levels[0]} / 队2 ${state.levels[1]}，底牌 ${state.buriedCount} 张`;

  renderSeats();
  renderTrick();
  renderHand();
  renderControls();
  renderLog();
}

function renderSeats() {
  for (const p of state.players) {
    const el = $(`seat${p.seat}`);
    el.className = `seat ${seatClass(p.seat)}${state.turn === p.seat ? " turn" : ""}`;
    el.dataset.seat = String(p.seat);
    const dealer = state.dealerSeat === p.seat ? " 庄" : "";
    const me = state.meSeat === p.seat ? " 我" : "";
    const conn = p.connected ? "" : " 离线";
    el.innerHTML = `
      <div class="name">${escapeHtml(p.name || `空座${p.seat + 1}`)}${dealer}${me}</div>
      <div class="sub">队${p.team + 1} · ${p.bot ? "机器人" : "玩家"}${conn} · ${p.handCount} 张</div>
    `;
  }
}

function seatClass(seat) {
  return ["seat-bottom", "seat-left", "seat-top", "seat-right"][seat] || "";
}

function renderTrick() {
  const el = $("trick");
  if (!state.trick) {
    el.innerHTML = "";
    return;
  }
  const playBySeat = new Map(state.trick.plays.map((play) => [play.seat, play]));
  const seats = [2, 1, 3, 0];
  el.innerHTML = `
    <div class="trick-orbit">
      ${seats
        .map((seat) => {
          const play = playBySeat.get(seat);
          if (!play) return "";
          const best = seat === state.trick.bestSeat ? " best" : "";
          return `
            <div class="trick-play trick-play-${seatPosition(seat)}${best}" data-seat="${seat}">
              <div class="trick-name">${escapeHtml(playerName(seat))}${best ? " · 最强" : ""}</div>
              <div class="trick-cards filled">
                ${play.cards.map(trickCardHtml).join("")}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderHand() {
  const hand = $("hand");
  const valid = new Set(state.hand.map((c) => c.uid));
  for (const uid of [...selected]) {
    if (!valid.has(uid)) selected.delete(uid);
  }
  const cards = [...state.hand].sort((a, b) => compareViewCard(a, b, state.trump));
  hand.innerHTML = cards.map(cardHtml).join("");
  hand.querySelectorAll("[data-uid]").forEach((card, index) => {
    card.style.zIndex = String(index + 1);
    card.style.setProperty("--stack-index", String(index));
    card.addEventListener("click", () => {
      const uid = card.dataset.uid;
      if (selected.has(uid)) selected.delete(uid);
      else selected.add(uid);
      render();
    });
  });
}

function renderControls() {
  const myTurn = state.meSeat === state.turn;
  $("botBtn").disabled = state.phase !== "lobby";
  $("startBtn").disabled = state.phase !== "lobby";
  $("passBtn").disabled = !(state.phase === "change" && state.meSeat === state.turn);
  $("changeBtn").disabled = !(state.phase === "change" && state.meSeat === state.turn && selected.size > 0);
  $("buryBtn").disabled = !((state.phase === "bury" || state.phase === "changeBury") && state.meSeat === state.dealerSeat && selected.size === 8);
  $("playBtn").disabled = !(state.phase === "play" && myTurn && selected.size > 0);
  if (state.phase === "bury" || state.phase === "changeBury") {
    $("status").textContent = state.meSeat === state.dealerSeat ? `请选择 8 张扣底，已选 ${selected.size}` : `等待 ${playerName(state.dealerSeat)} 扣底`;
  } else if (state.phase === "change") {
    $("status").textContent = state.meSeat === state.turn ? `可选择级牌或王对改主/攻主，或直接过` : `等待 ${playerName(state.turn)} 改主/攻主`;
  } else if (state.phase === "play") {
    $("status").textContent = myTurn ? `轮到你出牌，已选 ${selected.size}` : `等待 ${playerName(state.turn)} 出牌`;
  } else {
    $("status").textContent = "坐满 4 人或用机器人补位后开始";
  }
}

function renderLog() {
  $("log").innerHTML = state.logs
    .slice()
    .reverse()
    .map((line) => `<div class="log-line"><strong>${escapeHtml(line.at)}</strong> ${escapeHtml(line.text)}</div>`)
    .join("");
}

function cardHtml(card) {
  return playingCardHtml(card, {
    className: `table-card hand-card${selected.has(card.uid) ? " selected" : ""}`,
    attrs: `data-uid="${card.uid}"`
  });
}

function compareViewCard(a, b, trump) {
  const trumpA = isTrumpCard(a, trump) ? 1 : 0;
  const trumpB = isTrumpCard(b, trump) ? 1 : 0;
  if (trumpA !== trumpB) return trumpB - trumpA;
  const suitA = suitRank(a, trump);
  const suitB = suitRank(b, trump);
  if (suitA !== suitB) return suitB - suitA;
  return cardOrder(b, trump) - cardOrder(a, trump);
}

function seatPosition(seat) {
  return ["bottom", "left", "top", "right"][seat] || "bottom";
}

function suitRank(card, trump) {
  if (isTrumpCard(card, trump)) return 4;
  return { S: 3, H: 2, C: 1, D: 0 }[card.suit] ?? 0;
}

function isTrumpCard(card, trump) {
  if (!trump) return false;
  if (card.suit === "JOKER") return true;
  if (card.rank === trump.level) return true;
  return trump.suit !== "NT" && card.suit === trump.suit;
}

function cardOrder(card, trump) {
  if (card.rank === "RJ") return 1000;
  if (card.rank === "BJ") return 990;
  if (card.rank === trump.level && trump.suit !== "NT" && card.suit === trump.suit) return 980;
  if (card.rank === trump.level) return 960;
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const idx = ranks.indexOf(card.rank);
  return idx >= 0 ? idx : -1;
}

function miniCard(card) {
  return `<span class="mini-card${card.red ? " red" : ""}">${escapeHtml(card.label)}</span>`;
}

function trickCardHtml(card) {
  return playingCardHtml(card, {
    className: "table-card trick-card",
    attrs: `data-card-uid="${card.uid}"`
  });
}

function playingCardHtml(card, { className, attrs = "" }) {
  const [suit, rank] = splitLabel(card);
  const colorClass = card.red ? " red" : "";
  const face = card.suit === "JOKER" ? rank : suit;
  return `
    <button class="${className}${colorClass}" ${attrs} title="${escapeHtml(card.label)}" type="button">
      <span class="card-corner top">
        <span>${escapeHtml(rank)}</span>
        <span>${escapeHtml(suit)}</span>
      </span>
      <span class="card-face">${escapeHtml(face)}</span>
      <span class="card-corner bottom">
        <span>${escapeHtml(rank)}</span>
        <span>${escapeHtml(suit)}</span>
      </span>
    </button>
  `;
}

function capturePlayOrigins(ids) {
  const origins = new Map();
  ids.forEach((uid) => {
    const node = document.querySelector(`#hand [data-uid="${CSS.escape(uid)}"]`);
    if (node) origins.set(uid, node.getBoundingClientRect());
  });
  return origins;
}

function animateTrickArrival(prev, next) {
  if (!next?.trick) return;
  const addedPlays = Math.max(0, next.trick.plays.length - (prev?.trick?.plays.length || 0));
  if (prev?.trick && addedPlays === 0) return;
  const board = document.querySelector(".board");
  if (!board) return;
  const stageRect = board.getBoundingClientRect();
  const overlay = ensureTrickLayer(board);
  const trickArea = document.querySelector("#trick");
  const plays = prev?.trick ? next.trick.plays.slice(-addedPlays) : next.trick.plays;
  plays.forEach((play, playIndex) => {
    const seatNode = document.querySelector(`.seat[data-seat="${play.seat}"]`) || document.querySelector(`#seat${play.seat}`);
    const seatRect = seatNode?.getBoundingClientRect();
    play.cards.forEach((card, cardIndex) => {
      const target = trickArea.querySelector(`[data-card-uid="${CSS.escape(card.uid)}"]`);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const originRect = playOrigins.get(card.uid) || seatRect;
      if (!originRect) return;
      const ghost = document.createElement("div");
      ghost.className = "trick-ghost";
      ghost.innerHTML = playingCardHtml(card, { className: "table-card trick-card" });
      const startX = originRect.left - stageRect.left + originRect.width / 2 - 30;
      const startY = originRect.top - stageRect.top + originRect.height / 2 - 42;
      const endX = targetRect.left - stageRect.left;
      const endY = targetRect.top - stageRect.top;
      ghost.style.left = `${startX}px`;
      ghost.style.top = `${startY}px`;
      const dx = endX - startX;
      const dy = endY - startY;
      const rot = `${(cardIndex - 1) * 6 + playIndex * 3}deg`;
      overlay.appendChild(ghost);
      ghost.animate(
        [
          { transform: "translate3d(0,0,0) scale(0.72) rotate(-18deg)", opacity: 0.2, filter: "blur(1px)" },
          { transform: `translate3d(${dx * 0.45}px, ${dy * 0.45}px, 0) scale(0.9) rotate(-6deg)`, opacity: 1, offset: 0.72 },
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1) rotate(${rot})`, opacity: 1 }
        ],
        { duration: 520 + cardIndex * 90, easing: "cubic-bezier(.15,.85,.18,1)", fill: "forwards" }
      ).onfinish = () => ghost.remove();
    });
  });
  playOrigins = new Map();
}

function ensureTrickLayer(board) {
  let layer = board.querySelector(".trick-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "trick-layer";
    board.appendChild(layer);
  }
  return layer;
}

function splitLabel(card) {
  if (card.rank === "BJ") return ["", "小王"];
  if (card.rank === "RJ") return ["", "大王"];
  const suit = { S: "♠", H: "♥", C: "♣", D: "♦" }[card.suit] || "";
  return [suit, card.rank];
}

function trumpName(suit) {
  return { S: "黑桃", H: "红桃", C: "梅花", D: "方块", NT: "无主" }[suit] || suit;
}

function playerName(seat) {
  return state.players[seat]?.name || `座位${seat + 1}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
