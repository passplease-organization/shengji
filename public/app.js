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
  deal: "发牌中",
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
  animateDeal(prev, next);
  animateTrickArrival(prev, next);
  previousState = next;
});

socket.on("toast", showToast);

function render() {
  if (!state) return;
  $("code").textContent = state.code;
  $("phase").textContent = phaseName[state.phase] || state.phase;
  $("meta").textContent = `主：${trumpName(state.trump.suit)} ${state.trump.level} ｜ 坐庄队：${state.dealerTeam + 1} ｜ 抓分：${state.scores.attackers}`;
  const dealText = state.deal?.active ? `，发牌 ${state.deal.dealt}/${state.deal.total}` : "";
  $("score").textContent = `级数 队1 ${state.levels[0]} / 队2 ${state.levels[1]}，底牌 ${state.buriedCount} 张${dealText}`;

  renderSeats();
  renderTrick();
  renderHand();
  renderBidShortcuts();
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
  const notice = tableNoticeHtml();
  if (!state.trick) {
    el.innerHTML = notice;
    return;
  }
  const playBySeat = new Map(state.trick.plays.map((play) => [play.seat, play]));
  const seats = [2, 1, 3, 0];
  el.innerHTML = `
    ${notice}
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

function tableNoticeHtml() {
  const parts = [];
  const action = actionNotice();
  if (action) {
    const progress = state.deal?.active ? Math.round((state.deal.dealt / state.deal.total) * 100) : null;
    parts.push(`
      <div class="table-notice action-notice${action.urgent ? " urgent" : ""}">
        <span class="notice-icon">${escapeHtml(action.icon)}</span>
        <span class="notice-copy">
          <strong>${escapeHtml(action.title)}</strong>
          <small>${escapeHtml(action.detail)}</small>
        </span>
        ${progress === null ? "" : `<span class="notice-progress"><span style="width:${progress}%"></span></span>`}
      </div>
    `);
  }
  if (state.currentBid) {
    parts.push(`
      <div class="table-notice bid-notice">
        <span class="notice-icon">${suitIcon(state.currentBid.suit)}</span>
        <span class="notice-copy">
          <strong>${escapeHtml(playerName(state.currentBid.seat))} 亮主</strong>
          <small>${escapeHtml(trumpName(state.currentBid.suit))} ${escapeHtml(state.currentBid.level)}</small>
        </span>
        <span class="notice-cards">${state.currentBid.cards.map(miniCard).join("")}</span>
      </div>
    `);
  }
  const notices = parts.length ? `<div class="table-notices">${parts.join("")}</div>` : "";
  const deck = state.deal?.active ? `<div class="deal-deck" aria-hidden="true"><span></span><span></span><span></span></div>` : "";
  return `${notices}${deck}`;
}

function actionNotice() {
  if (state.phase === "deal") {
    const dealt = state.deal ? `${state.deal.dealt}/${state.deal.total}` : "";
    return { title: "发牌中", detail: `${dealt} · 拿到级牌可以叫主`, icon: "发", urgent: false };
  }
  if (state.phase === "bury" || state.phase === "changeBury") {
    return state.meSeat === state.dealerSeat
      ? { title: "轮到你扣底", detail: "选择 8 张放入底牌", icon: "底", urgent: true }
      : { title: "等待扣底", detail: `${playerName(state.dealerSeat)} 正在扣底`, icon: "等", urgent: false };
  }
  if (state.phase === "change") {
    return state.meSeat === state.turn
      ? { title: "轮到你改主", detail: "可改主/攻主，或直接过", icon: "改", urgent: true }
      : { title: "等待改主", detail: `${playerName(state.turn)} 正在选择`, icon: "等", urgent: false };
  }
  if (state.phase === "play") {
    if (state.trick?.reviewing) {
      return { title: "本轮结束", detail: `${playerName(state.trick.bestSeat)} 赢得本轮`, icon: "赢", urgent: false };
    }
    return state.meSeat === state.turn
      ? { title: "轮到你出牌", detail: `已选 ${selected.size} 张`, icon: "出", urgent: true }
      : { title: "等待出牌", detail: `${playerName(state.turn)} 正在出牌`, icon: "等", urgent: false };
  }
  return null;
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

function renderBidShortcuts() {
  const el = $("bidShortcuts");
  const offers = possibleTrumpOffers();
  if (!offers.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `
    <span class="shortcut-label">${state.phase === "deal" ? "可叫主" : "可改主"}</span>
    ${offers
      .map(
        (offer, index) => `
          <button class="bid-chip${offer.red ? " red" : ""}" data-offer="${index}" type="button">
            <span>${escapeHtml(offer.name)}</span>
            <small>${offer.cards.map((c) => c.label).join(" ")}</small>
          </button>
        `
      )
      .join("")}
  `;
  el.querySelectorAll("[data-offer]").forEach((button) => {
    button.addEventListener("click", async () => {
      const offer = offers[Number(button.dataset.offer)];
      if (!offer) return;
      selected.clear();
      offer.cards.forEach((card) => selected.add(card.uid));
      playOrigins = capturePlayOrigins(offer.cards.map((card) => card.uid));
      render();
      const res = await api("changeTrump", { ids: offer.cards.map((card) => card.uid) });
      if (res?.ok) selected.clear();
    });
  });
}

function renderControls() {
  const myTurn = state.meSeat === state.turn;
  $("botBtn").disabled = state.phase !== "lobby";
  $("startBtn").disabled = state.phase !== "lobby";
  $("changeBtn").textContent = state.phase === "deal" ? "叫主" : "改主/攻主";
  $("passBtn").disabled = !(state.phase === "change" && state.meSeat === state.turn);
  $("changeBtn").disabled = !(
    (state.phase === "deal" && selected.size > 0) ||
    (state.phase === "change" && state.meSeat === state.turn && selected.size > 0)
  );
  $("buryBtn").disabled = !((state.phase === "bury" || state.phase === "changeBury") && state.meSeat === state.dealerSeat && selected.size === 8);
  $("playBtn").disabled = !(state.phase === "play" && myTurn && selected.size > 0 && !state.trick?.reviewing);
  if (state.phase === "deal") {
    const dealt = state.deal ? `${state.deal.dealt}/${state.deal.total}` : "";
    $("status").textContent = `正在发牌 ${dealt}，拿到本方级牌时可选择后叫主`;
  } else if (state.phase === "bury" || state.phase === "changeBury") {
    $("status").textContent = state.meSeat === state.dealerSeat ? `请选择 8 张扣底，已选 ${selected.size}` : `等待 ${playerName(state.dealerSeat)} 扣底`;
  } else if (state.phase === "change") {
    $("status").textContent = state.meSeat === state.turn ? `可选择级牌或王对改主/攻主，或直接过` : `等待 ${playerName(state.turn)} 改主/攻主`;
  } else if (state.phase === "play") {
    $("status").textContent = state.trick?.reviewing
      ? `本轮结束，${playerName(state.trick.bestSeat)} 赢得本轮`
      : myTurn
        ? `轮到你出牌，已选 ${selected.size}`
        : `等待 ${playerName(state.turn)} 出牌`;
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

function possibleTrumpOffers() {
  if (!state || (state.phase !== "deal" && state.phase !== "change")) return [];
  if (state.phase === "change" && state.meSeat !== state.turn) return [];
  const me = state.players[state.meSeat];
  if (!me) return [];
  const level = state.levels[me.team];
  const bySuit = new Map();
  for (const suit of ["S", "H", "C", "D"]) {
    bySuit.set(
      suit,
      state.hand.filter((card) => card.rank === level && card.suit === suit)
    );
  }
  const redJokers = state.hand.filter((card) => card.rank === "RJ");
  const blackJokers = state.hand.filter((card) => card.rank === "BJ");
  const offers = [];
  for (const suit of ["S", "H", "C", "D"]) {
    const levels = bySuit.get(suit);
    if (!levels.length) continue;
    const matchingJokers = (suit === "H" || suit === "D") ? redJokers : blackJokers;
    const baseCards = levels.slice(0, Math.min(2, levels.length));
    addOffer(offers, suit, level, baseCards);
    if (matchingJokers.length) addOffer(offers, suit, level, [...baseCards, matchingJokers[0]]);
  }
  if (redJokers.length && blackJokers.length) {
    addOffer(offers, "NT", level, [blackJokers[0], redJokers[0]]);
  }
  return offers
    .filter((offer) => offer.power > (state.bidPower || 0))
    .sort((a, b) => b.power - a.power || a.sort - b.sort)
    .slice(0, 6);
}

function addOffer(offers, suit, level, cards) {
  const power = suit === "NT" ? 9 : cards.reduce((sum, card) => sum + (card.rank === level ? 1 : 2), 0);
  const red = suit === "H" || suit === "D" || suit === "NT";
  offers.push({
    suit,
    level,
    cards,
    power,
    red,
    sort: { S: 0, H: 1, C: 2, D: 3, NT: 4 }[suit],
    name: `${trumpName(suit)} ${level}`
  });
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
  const jokerClass = card.suit === "JOKER" ? " joker" : "";
  const face = card.suit === "JOKER" ? rank : suit;
  return `
    <button class="${className}${colorClass}${jokerClass}" ${attrs} title="${escapeHtml(card.label)}" type="button">
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

function animateDeal(prev, next) {
  if (!next?.deal?.active) return;
  const previousDealt = prev?.deal?.active ? prev.deal.dealt : 0;
  const currentDealt = next.deal.dealt || 0;
  const added = currentDealt - previousDealt;
  if (added <= 0 || added > 12) return;
  const board = document.querySelector(".board");
  if (!board) return;
  const boardRect = board.getBoundingClientRect();
  const layer = ensureTrickLayer(board);
  const fromX = boardRect.width / 2 - 22;
  const fromY = boardRect.height / 2 - 31;
  for (let n = previousDealt; n < currentDealt; n += 1) {
    const seat = n % 4;
    const target = dealTargetForSeat(seat, boardRect);
    if (!target) continue;
    const ghost = document.createElement("div");
    ghost.className = "deal-ghost";
    ghost.style.left = `${fromX}px`;
    ghost.style.top = `${fromY}px`;
    layer.appendChild(ghost);
    const dx = target.x - fromX;
    const dy = target.y - fromY;
    const delay = Math.min((n - previousDealt) * 38, 220);
    ghost.animate(
      [
        { transform: "translate3d(0,0,0) scale(.82) rotate(-8deg)", opacity: 0.1 },
        { transform: `translate3d(${dx * 0.55}px, ${dy * 0.48}px, 0) scale(.96) rotate(${seat * 5 - 8}deg)`, opacity: 1, offset: 0.66 },
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(.72) rotate(${seat * 8 - 12}deg)`, opacity: 0.05 }
      ],
      { duration: 460, delay, easing: "cubic-bezier(.16,.82,.22,1)", fill: "forwards" }
    ).onfinish = () => ghost.remove();
  }
}

function dealTargetForSeat(seat, boardRect) {
  if (seat === state.meSeat) {
    const handRect = $("hand")?.getBoundingClientRect();
    if (handRect) {
      return {
        x: handRect.left - boardRect.left + Math.min(handRect.width - 80, 80 + state.hand.length * 18),
        y: handRect.top - boardRect.top + 20
      };
    }
  }
  const seatNode = document.querySelector(`#seat${seat}`);
  const rect = seatNode?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: rect.left - boardRect.left + rect.width / 2 - 22,
    y: rect.top - boardRect.top + rect.height / 2 - 31
  };
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
      const startX = originRect.left - stageRect.left + originRect.width / 2 - 39;
      const startY = originRect.top - stageRect.top + originRect.height / 2 - 55;
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

function suitIcon(suit) {
  return { S: "♠", H: "♥", C: "♣", D: "♦", NT: "王" }[suit] || "主";
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
