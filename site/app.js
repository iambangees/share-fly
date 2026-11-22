/* Share Fly — browser-to-browser file sharing over WebRTC (PeerJS signalling).
 * Nothing is uploaded to a server: files travel directly between the two
 * browsers. The PeerJS cloud only introduces the two peers to each other.
 * Pure helpers at the top are Node-testable; browser wiring is guarded. */
"use strict";

var CHUNK = 16384; // 16 KiB per data-channel message
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/l
var PEER_PREFIX = "sharefly-";

function makeCode(rand) {
  rand = rand || Math.random;
  var out = "";
  for (var i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return out;
}

function peerIdFor(code) {
  return PEER_PREFIX + String(code || "").trim().toLowerCase();
}

function codeFromPeerId(id) {
  return String(id || "").replace(new RegExp("^" + PEER_PREFIX), "").toUpperCase();
}

function receiveUrl(origin, path, code) {
  return origin + path + "?code=" + encodeURIComponent(code);
}

function chunkRanges(size, chunk) {
  chunk = chunk || CHUNK;
  var ranges = [];
  for (var start = 0; start < size; start += chunk) {
    ranges.push([start, Math.min(size, start + chunk)]);
  }
  return ranges;
}

function fmtBytes(n) {
  if (!isFinite(n)) return "–";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function concatChunks(chunks) {
  var total = 0, i;
  for (i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
  var out = new Uint8Array(total), at = 0;
  for (i = 0; i < chunks.length; i++) {
    out.set(new Uint8Array(chunks[i]), at);
    at += chunks[i].byteLength;
  }
  return out;
}

function parseCodeFromSearch(search) {
  try {
    var m = /[?&]code=([^&#]*)/.exec(search || "");
    if (!m) return "";
    var code = decodeURIComponent(m[1]).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return code.length === 6 ? code : "";
  } catch (e) { return ""; }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CHUNK: CHUNK, makeCode: makeCode, peerIdFor: peerIdFor,
    codeFromPeerId: codeFromPeerId, receiveUrl: receiveUrl,
    chunkRanges: chunkRanges, fmtBytes: fmtBytes, concatChunks: concatChunks,
    parseCodeFromSearch: parseCodeFromSearch };
}

/* ---------------- browser wiring (not run under Node) ---------------- */
if (typeof window !== "undefined" && typeof document !== "undefined") {
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var peer = null, conn = null, role = null, myCode = "";
  var sendFiles = [];            // File[]
  var sendState = null;          // { index, sent, total }
  var recvFiles = [];            // { name, size, type, chunks: [], received, done, url }
  var wakeLock = null;

  function log(msg, kind) {
    var el = $("statusLog");
    if (!el) return;
    var div = document.createElement("div");
    div.textContent = msg;
    if (kind === "err") div.style.color = "#ffb4ab";
    if (kind === "ok") div.style.color = "#7ee2a8";
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(msg) { var el = $("connStatus"); if (el) el.textContent = msg; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function keepAwake() {
    try {
      if (navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); }
    } catch (e) { /* best effort only */ }
  }
  function releaseAwake() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }

  function loadPeerJS() {
    if (typeof Peer !== "undefined") return Promise.resolve();
    var urls = [
      "peerjs.min.js",
      "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js",
      "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"
    ];
    function tryNext(i) {
      if (i >= urls.length) return Promise.reject(new Error("PeerJS library failed to load from both CDNs"));
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = urls[i];
        s.onload = function () { resolve(); };
        s.onerror = function () { tryNext(i + 1).then(resolve, reject); };
        document.head.appendChild(s);
      });
    }
    return tryNext(0);
  }

  function friendlyPeerError(err) {
    var t = (err && err.type) || "";
    if (t === "peer-unavailable") return "No sender is online with that code — check the code, and make sure the sender still has this page open.";
    if (t === "network" || t === "socket-error" || t === "server-error") return "Could not reach the connection server — check your internet and try again.";
    if (t === "unavailable-id") return "That code is already in use right now — tap “New code” for a fresh one.";
    return "Connection failed" + (err && err.message ? ": " + err.message : "") + ". Try again.";
  }

  function endSession(msg) {
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    conn = null; peer = null; role = null;
    releaseAwake();
    $("btnEnd").style.display = "none";
    $("btnSendCode").disabled = false;
    $("btnReceive").disabled = false;
    if (msg) log(msg);
    setStatus("Not connected");
  }

  /* ---------- tabs ---------- */
  function showTab(which) {
    $("tabSend").style.display = which === "send" ? "block" : "none";
    $("tabReceive").style.display = which === "receive" ? "block" : "none";
    $("btnTabSend").classList.toggle("active", which === "send");
    $("btnTabReceive").classList.toggle("active", which === "receive");
  }
  $("btnTabSend").onclick = function () { showTab("send"); };
  $("btnTabReceive").onclick = function () { showTab("receive"); };

  /* ---------- sender side ---------- */
  var dropZone = $("dropZone"), fileInput = $("fileInput");
  function renderSendList() {
    var el = $("sendList");
    el.innerHTML = "";
    if (!sendFiles.length) {
      el.innerHTML = '<div class="empty">No files picked yet.</div>';
      $("btnSendCode").disabled = true;
      return;
    }
    var total = 0;
    sendFiles.forEach(function (f, i) {
      total += f.size;
      var row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = '<span class="fname"></span><span class="fsize"></span><span class="fprog"></span>';
      row.querySelector(".fname").textContent = f.name;
      row.querySelector(".fsize").textContent = fmtBytes(f.size);
      row.querySelector(".fprog").textContent = "";
      row.querySelector(".fprog").id = "send-prog-" + i;
      el.appendChild(row);
    });
    $("sendTotal").textContent = sendFiles.length + " file" + (sendFiles.length > 1 ? "s" : "") + " · " + fmtBytes(total);
    $("btnSendCode").disabled = false;
  }
  function addFiles(list) {
    for (var i = 0; i < list.length; i++) sendFiles.push(list[i]);
    renderSendList();
  }
  $("btnPick").onclick = function () { fileInput.click(); };
  fileInput.addEventListener("change", function () { addFiles(fileInput.files); fileInput.value = ""; });
  ["dragover", "dragenter"].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.remove("drag"); });
  });
  dropZone.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  $("btnClearFiles").onclick = function () { sendFiles = []; renderSendList(); $("sendTotal").textContent = ""; };

  function renderQR(text) {
    var stage = $("qrStage");
    if (typeof qrcode === "undefined") { stage.innerHTML = '<div class="empty">QR library did not load — the code above still works typed in by hand.</div>'; return; }
    try {
      var qr = qrcode(0, "M"); qr.addData(text); qr.make();
      var count = qr.getModuleCount(), size = 200, quiet = 4, total = count + quiet * 2, cell = size / total;
      var canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#000000";
      for (var r = 0; r < count; r++) for (var c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(Math.round((c + quiet) * cell), Math.round((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
      stage.innerHTML = ""; stage.appendChild(canvas);
    } catch (e) { stage.innerHTML = '<div class="empty">Link too long for a QR code — copy the link instead.</div>'; }
  }

  $("btnSendCode").onclick = async function () {
    if (!sendFiles.length) return;
    $("btnSendCode").disabled = true;
    setStatus("Starting…");
    try { await loadPeerJS(); } catch (e) { log(e.message, "err"); $("btnSendCode").disabled = false; setStatus("Not connected"); return; }
    myCode = makeCode();
    var id = peerIdFor(myCode);
    peer = new Peer(id);
    role = "send";
    peer.on("open", function () {
      var url = receiveUrl(location.origin, location.pathname, myCode);
      $("sendCode").textContent = myCode;
      $("sendLink").textContent = url;
      $("sendLink").href = url;
      $("shareBox").style.display = "block";
      renderQR(url);
      setStatus("Waiting for the other device — share the code or QR");
      log("Code " + myCode + " is live. Waiting for the receiver…");
      keepAwake();
      $("btnEnd").style.display = "inline-block";
    });
    peer.on("connection", function (c) {
      conn = c;
      conn.on("open", function () {
        setStatus("Connected — sending file list…");
        log("Other device connected.", "ok");
        conn.send({ t: "meta", files: sendFiles.map(function (f) { return { name: f.name, size: f.size, type: f.type || "application/octet-stream" }; }) });
      });
      conn.on("data", function (data) {
        if (data && data.t === "go") sendAllFiles();
        if (data && data.t === "bye") { log("Receiver left."); }
      });
      conn.on("close", function () { log("Other device disconnected."); setStatus("Disconnected"); });
      conn.on("error", function (e) { log("Connection error: " + (e && e.message ? e.message : e), "err"); });
    });
    peer.on("error", function (err) { log(friendlyPeerError(err), "err"); setStatus("Not connected"); $("btnSendCode").disabled = false; });
  };

  $("btnCopyCode").onclick = async function () {
    try { await navigator.clipboard.writeText(myCode); $("btnCopyCode").textContent = "Copied ✓"; setTimeout(function () { $("btnCopyCode").textContent = "Copy code"; }, 1600); } catch (e) { log("Copy failed — long-press the code to copy it manually.", "err"); }
  };
  $("btnCopyLink").onclick = async function () {
    var url = receiveUrl(location.origin, location.pathname, myCode);
    try { await navigator.clipboard.writeText(url); $("btnCopyLink").textContent = "Copied ✓"; setTimeout(function () { $("btnCopyLink").textContent = "Copy link"; }, 1600); } catch (e) { log("Copy failed — long-press the link to copy it manually.", "err"); }
  };
  $("btnNewCode").onclick = function () { endSession("Session ended — pick files again for a fresh code."); $("shareBox").style.display = "none"; };

  async function sendAllFiles() {
    var dc = conn && conn.dataChannel;
    for (var i = 0; i < sendFiles.length; i++) {
      var f = sendFiles[i];
      conn.send({ t: "start", i: i });
      var buf = await f.arrayBuffer();
      var ranges = chunkRanges(buf.byteLength);
      var sent = 0;
      for (var j = 0; j < ranges.length; j++) {
        while (dc && dc.bufferedAmount > 512 * 1024) await sleep(50);
        conn.send(buf.slice(ranges[j][0], ranges[j][1]));
        sent = ranges[j][1];
        var prog = $("send-prog-" + i);
        if (prog) prog.textContent = Math.round((sent / f.size) * 100) + "%";
      }
      conn.send({ t: "done", i: i });
      var progDone = $("send-prog-" + i);
      if (progDone) progDone.textContent = "Sent ✓";
      log("Sent " + f.name + " (" + fmtBytes(f.size) + ").", "ok");
    }
    setStatus("All files sent ✓ — you can close this page now");
    log("All " + sendFiles.length + " file(s) sent. Nothing was stored anywhere.", "ok");
  }

  /* ---------- receiver side ---------- */
  function renderRecvList() {
    var el = $("recvList");
    el.innerHTML = "";
    if (!recvFiles.length) { el.innerHTML = '<div class="empty">Nothing received yet.</div>'; return; }
    recvFiles.forEach(function (rf, i) {
      var row = document.createElement("div");
      row.className = "file-row";
      var link = rf.url ? '<a class="dl" href="' + rf.url + '" download="' + rf.name.replace(/"/g, "") + '">Download</a>' : '<span class="fprog" id="recv-prog-' + i + '">0%</span>';
      row.innerHTML = '<span class="fname"></span><span class="fsize"></span>' + link;
      row.querySelector(".fname").textContent = rf.name;
      row.querySelector(".fsize").textContent = fmtBytes(rf.size);
      el.appendChild(row);
    });
  }

  $("btnReceive").onclick = async function () {
    var code = $("recvCode").value.trim().toUpperCase();
    if (code.length !== 6) { log("Type the 6-letter code from the sender.", "err"); return; }
    $("btnReceive").disabled = true;
    setStatus("Connecting…");
    try { await loadPeerJS(); } catch (e) { log(e.message, "err"); $("btnReceive").disabled = false; setStatus("Not connected"); return; }
    peer = new Peer(); // random own id; we dial the sender
    role = "receive";
    peer.on("open", function () {
      conn = peer.connect(peerIdFor(code), { reliable: true });
      conn.on("open", function () {
        setStatus("Connected to sender — waiting for the file list…");
        log("Connected to sender " + code + ".", "ok");
        keepAwake();
        $("btnEnd").style.display = "inline-block";
      });
      conn.on("data", function (data) { onRecvData(data); });
      conn.on("close", function () { log("Sender disconnected."); setStatus("Disconnected"); });
      conn.on("error", function (e) { log("Connection error: " + (e && e.message ? e.message : e), "err"); });
    });
    peer.on("error", function (err) { log(friendlyPeerError(err), "err"); setStatus("Not connected"); $("btnReceive").disabled = false; });
  };

  var currentRecv = -1;
  function onRecvData(data) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      var buf = data instanceof ArrayBuffer ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (currentRecv < 0 || !recvFiles[currentRecv]) return;
      var rf = recvFiles[currentRecv];
      rf.chunks.push(data);
      rf.received += data.byteLength;
      var prog = $("recv-prog-" + currentRecv);
      if (prog) prog.textContent = Math.round((rf.received / Math.max(1, rf.size)) * 100) + "%";
      return;
    }
    if (!data || typeof data !== "object") return;
    if (data.t === "meta") {
      recvFiles = data.files.map(function (f) { return { name: f.name, size: f.size, type: f.type, chunks: [], received: 0, done: false, url: null }; });
      renderRecvList();
      setStatus("Receiving " + recvFiles.length + " file(s)…");
      log("Sender is sharing " + recvFiles.length + " file(s).", "ok");
      conn.send({ t: "go" });
    } else if (data.t === "start") {
      currentRecv = data.i;
    } else if (data.t === "done") {
      var doneFile = recvFiles[data.i];
      if (!doneFile) return;
      var bytes = concatChunks(doneFile.chunks);
      var blob = new Blob([bytes], { type: doneFile.type || "application/octet-stream" });
      doneFile.url = URL.createObjectURL(blob);
      doneFile.done = true;
      currentRecv = -1;
      renderRecvList();
      log("Received " + doneFile.name + " (" + fmtBytes(doneFile.size) + ") — tap Download to save it.", "ok");
      if (recvFiles.every(function (x) { return x.done; })) {
        setStatus("All files received ✓ — tap Download on each to save them");
      }
    }
  }

  $("btnEnd").onclick = function () { endSession("Session ended."); $("shareBox").style.display = "none"; };

  /* ---------- deep link: ?code=XXXXXX opens Receive and connects ---------- */
  var deepCode = parseCodeFromSearch(location.search);
  if (deepCode) {
    showTab("receive");
    $("recvCode").value = deepCode;
    log("Code " + deepCode + " came from the link — tap Connect, or it connects automatically.");
    setTimeout(function () { if (!$("btnReceive").disabled) $("btnReceive").click(); }, 600);
  } else {
    showTab("send");
  }
  renderSendList();
  renderRecvList();
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
}
