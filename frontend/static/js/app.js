
function formatTime(dateStr) {
  if (!dateStr) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const str = String(dateStr).trim();
  if (str.includes("/")) return str;
  try {
    const parts = str.split(" ");
    if (parts.length >= 2 && parts[0].includes("-")) {
      const ymd = parts[0].split("-");
      if (ymd.length === 3) {
        return `${ymd[2]}/${ymd[1]}/${ymd[0]} ${parts[1]}`;
      }
    }
  } catch (e) {}
  return str;
}

let isCurrentInStage2 = false;
let currentInspectedBoxes = [];

function isDummyInspection(box) {
  if (!box) return false;
  const str = typeof box === "string" ? box : (box.box_no || box.box_barcode || "");
  return String(str).trim().toUpperCase().startsWith("DUMMY");
}

function getRealInspectedBoxes() {
  return currentInspectedBoxes.filter(b => !isDummyInspection(b));
}
/**
  =============================================================================
  CiRA CORE Machine Vision Inspection System - Frontend Controller
  Cyber-Industrial HMI for Murata Electronics (Thailand) Co., Ltd. - DX12
  =============================================================================
*/

let ws = null;
let currentLotData = null;
let cachedInspections = [];
let currentZoomLevel = 1.0;

// DOM References
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");
const headerOperator = document.getElementById("headerOperator");
const headerOperatorName = document.getElementById("headerOperatorName");
const headerLot = document.getElementById("headerLot");
const headerModel = document.getElementById("headerModel");
const clockDate = document.getElementById("clockDate");
const clockTime = document.getElementById("clockTime");

const cameraWindow = document.getElementById("cameraWindow");
const liveFeedImg = document.getElementById("liveFeedImg");
if (liveFeedImg) {
  liveFeedImg.onerror = () => {
    setTimeout(() => {
      if (liveFeedImg && !liveFeedImg.src.startsWith("data:")) {
        liveFeedImg.src = "/video_feed?t=" + Date.now();
      }
    }, 1500);
  };
}
const camRoiGuide = document.getElementById("camRoiGuide");
const viewBoxBarcode = document.getElementById("viewBoxBarcode");
const barcodeInput = document.getElementById("barcodeInput");
const btnBypass = document.getElementById("btnBypass");
const btnClearAlarm = document.getElementById("btnClearAlarm");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const themeBtnText = document.getElementById("themeBtnText");

// Machine Vision Result Signboard References
const hmiStatusBar = document.getElementById("hmiStatusBar");
const signCircleIcon = document.getElementById("signCircleIcon");
const statusHeadline = document.getElementById("statusHeadline");
const statusCaption = document.getElementById("statusCaption");
const statusConf = document.getElementById("statusConf");

// Lot Progress Bar References
const lotProgressBar = document.getElementById("lotProgressBar");
const progressBoxesText = document.getElementById("progressBoxesText");
const progressPctText = document.getElementById("progressPctText");

// KPI Stats References
const statBoxesDone = document.getElementById("statBoxesDone");
const statTargetBoxes = document.getElementById("statTargetBoxes");
const statGoodPieces = document.getElementById("statGoodPieces");
const statDefectPieces = document.getElementById("statDefectPieces");
const statYieldRate = document.getElementById("statYieldRate");
const donutProgressCircle = document.getElementById("donutProgressCircle");
const perBoxChartContainer = document.getElementById("perBoxChartContainer");

// Dummy Test References
const btnDummyGood = document.getElementById("btnDummyGood");
const btnDummyNG = document.getElementById("btnDummyNG");

// PIN Authentication References
let enteredPin = "";
const pinLoginScreen = document.getElementById("pinLoginScreen");
const pinFeedback = document.getElementById("pinFeedback");

// Notification Center
const notifyDrawer = document.getElementById("notifyDrawer");
const notifyBadgeCount = document.getElementById("notifyBadgeCount");
const notifyEventList = document.getElementById("notifyEventList");

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initClock();
  initPerBoxChart(20);
  connectWebSocket();
  initBarcodeScannerListener();
  initPinAuthListener();
  loadInitialTraceability();
});

// ---------------- Real-time Digital Clock ----------------
function initClock() {
  function updateTime() {
    const now = new Date();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dStr = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    const tStr = now.toTimeString().split(" ")[0];

    if (clockDate) clockDate.textContent = dStr;
    if (clockTime) clockTime.textContent = tStr;
  }
  updateTime();
  setInterval(updateTime, 1000);
}

// ---------------- Theme Management (Light / Dark) ----------------
function initTheme() {
  const savedTheme = localStorage.getItem("cira_theme") || "dark";
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("cira_theme", theme);
  if (themeBtnText) {
    themeBtnText.textContent = (theme === "dark") ? "โหมดสว่าง" : "โหมดมืด";
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
  const newTheme = (currentTheme === "dark") ? "light" : "dark";
  applyTheme(newTheme);
}

// ---------------- Camera Overlay Utilities ----------------
function toggleCamZoom() {
  if (currentZoomLevel === 1.0) {
    currentZoomLevel = 1.5;
  } else if (currentZoomLevel === 1.5) {
    currentZoomLevel = 2.0;
  } else {
    currentZoomLevel = 1.0;
  }
  if (liveFeedImg) {
    liveFeedImg.style.transform = `scale(${currentZoomLevel})`;
    liveFeedImg.style.transition = "transform 0.2s ease";
  }
}

function toggleRoiGuide() {
  if (camRoiGuide) {
    camRoiGuide.classList.toggle("active");
  }
}

function toggleCamFullscreen() {
  if (!document.fullscreenElement) {
    cameraWindow?.requestFullscreen().catch(err => console.warn(err));
  } else {
    document.exitFullscreen().catch(err => console.warn(err));
  }
}

// ---------------- Notification Center Drawer ----------------
function toggleNotifyDrawer() {
  if (notifyDrawer) {
    notifyDrawer.classList.toggle("active");
  }
}

function addNotification(title, message, type = "info") {
  if (!notifyEventList) return;
  const now = new Date().toTimeString().split(" ")[0];
  const card = document.createElement("div");
  card.className = `notify-event-card ${type}`;
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700;">
      <span>${title}</span>
      <span style="font-family: var(--font-mono); color: var(--text-muted);">${now}</span>
    </div>
    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${message}</div>
  `;
  notifyEventList.prepend(card);

  // Update badge count
  if (notifyBadgeCount) {
    const current = parseInt(notifyBadgeCount.textContent) || 0;
    notifyBadgeCount.textContent = current + 1;
  }
}

// ---------------- 20-Bar Per-box Inspection Chart ----------------
function initPerBoxChart(totalBars = 20) {
  if (!perBoxChartContainer) return;
  perBoxChartContainer.innerHTML = "";
  for (let i = 0; i < totalBars; i++) {
    const bar = document.createElement("div");
    bar.className = "box-mini-bar";
    bar.id = `chartBar_${i}`;
    bar.title = `กล่องที่ ${i + 1}: รอดำเนินการ`;
    perBoxChartContainer.appendChild(bar);
  }
}

function updatePerBoxChart(inspections, totalTarget = 20) {
  if (!perBoxChartContainer) return;

  // Clear or resize if target changed
  const currentBars = perBoxChartContainer.querySelectorAll(".box-mini-bar");
  if (currentBars.length !== totalTarget) {
    initPerBoxChart(totalTarget);
  }

  // inspections is sorted newest first or oldest first. Let's sort oldest first for bars 1..N
  const sorted = [...inspections].sort((a, b) => a.id - b.id);

  for (let i = 0; i < totalTarget; i++) {
    const bar = document.getElementById(`chartBar_${i}`);
    if (!bar) continue;

    if (i < sorted.length) {
      const item = sorted[i];
      bar.classList.remove("good", "ng", "bypassed");
      if (item.final_result === "G") {
        if (item.is_bypassed) {
          bar.classList.add("bypassed");
          bar.title = `กล่องที่ ${i + 1} (${item.box_barcode}): PASS [G] (Bypass โดย ${item.bypassed_by || 'Leader'})`;
        } else {
          bar.classList.add("good");
          bar.title = `กล่องที่ ${i + 1} (${item.box_barcode}): PASS [G] (${item.confidence_score.toFixed(1)}%)`;
        }
      } else {
        bar.classList.add("ng");
        bar.title = `กล่องที่ ${i + 1} (${item.box_barcode}): FAIL [NG] (${item.confidence_score.toFixed(1)}%)`;
      }
    } else {
      bar.className = "box-mini-bar";
      bar.title = `กล่องที่ ${i + 1}: รอดำเนินการ`;
    }
  }
}

// ---------------- Authentication & Login Logic (Operator ID / PIN) ----------------
let currentLoginMode = "operator";

function initPinAuthListener() {
  const savedOpId = sessionStorage.getItem("cira_operator_id") || "MTL80343";
  const savedOpName = sessionStorage.getItem("cira_operator_name") || "Aun";
  if (headerOperator) headerOperator.textContent = savedOpId;
  if (headerOperatorName) headerOperatorName.textContent = `(${savedOpName})`;

  if (sessionStorage.getItem("cira_pin_auth") === "true") {
    if (pinLoginScreen) {
      pinLoginScreen.classList.add("logged-in");
      pinLoginScreen.style.setProperty("display", "none", "important");
    }
    // Auto-pop the New Lot modal if no active lot or if lot is closed/idle
    setTimeout(() => {
      fetch("/api/telemetry")
        .then(r => r.json())
        .then(data => {
          if (!data.current_lot_id || data.state === "IDLE" || data.state === "LOT_CLOSED" || data.state === "LOT_COMPLETE") {
            openPreLotModal(false);
          }
        })
        .catch(() => {
          openPreLotModal(false);
        });
    }, 350);
  } else {
    if (pinLoginScreen) {
      pinLoginScreen.classList.remove("logged-in");
      pinLoginScreen.style.removeProperty("display");
      pinLoginScreen.style.display = "flex";
      pinLoginScreen.style.opacity = "1";
    }
    setTimeout(() => {
      const opInput = document.getElementById("loginOperatorInput");
      const nameInput = document.getElementById("loginOperatorNameInput");
      if (opInput && savedOpId) opInput.value = savedOpId;
      if (nameInput && savedOpName) nameInput.value = savedOpName;
      if (opInput) opInput.focus();
    }, 100);
  }

  // Physical Keyboard Listener for PIN & Operator modes
  window.addEventListener("keydown", (e) => {
    if (pinLoginScreen && pinLoginScreen.style.display !== "none") {
      if (currentLoginMode === "pin") {
        if (e.key >= "0" && e.key <= "9") {
          pressPinKey(e.key);
        } else if (e.key === "Backspace") {
          backspacePin();
        } else if (e.key === "Escape") {
          clearPin();
        } else if (e.key === "Enter") {
          verifyPin();
        }
      } else {
        if (e.key === "Enter") {
          submitOperatorLogin();
        }
      }
    }
  });
}

function switchLoginMode(mode) {
  currentLoginMode = mode;
  const viewOp = document.getElementById("loginViewOperator");
  const viewPin = document.getElementById("loginViewPin");
  const btnOp = document.getElementById("tabBtnOperator");
  const btnPin = document.getElementById("tabBtnPin");

  if (mode === "operator") {
    if (viewOp) viewOp.style.display = "block";
    if (viewPin) viewPin.style.display = "none";
    if (btnOp) btnOp.classList.add("active");
    if (btnPin) btnPin.classList.remove("active");
    const opInput = document.getElementById("loginOperatorInput");
    if (opInput) {
      setTimeout(() => opInput.focus(), 50);
    }
  } else {
    if (viewOp) viewOp.style.display = "none";
    if (viewPin) viewPin.style.display = "block";
    if (btnPin) btnPin.classList.add("active");
    if (btnOp) btnOp.classList.remove("active");
    clearPin();
  }
}

function togglePasswordVisibility() {
  const pwdInput = document.getElementById("loginPasswordInput");
  const eyeIcon = document.getElementById("pwdEyeIcon");
  if (!pwdInput) return;
  if (pwdInput.type === "password") {
    pwdInput.type = "text";
    if (eyeIcon) {
      eyeIcon.innerHTML = '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>';
    }
  } else {
    pwdInput.type = "password";
    if (eyeIcon) {
      eyeIcon.innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
    }
  }
}

function showForgotPwdAlert() {
  const fb = document.getElementById("pinFeedback");
  if (fb) {
    fb.style.color = "#38bdf8";
    fb.textContent = "ℹ️ ติดต่อ System Admin / DX12 (รหัสเริ่มต้น: MTL80343 / 123456)";
  }
}

window.isOperatorLoginRunning = false;

function submitOperatorLogin() {
  if (window.isOperatorLoginRunning) return;
  window.isOperatorLoginRunning = true;

  const opInput = document.getElementById("loginOperatorInput");
  const nameInput = document.getElementById("loginOperatorNameInput");
  const opId = (opInput ? opInput.value : "").trim() || "MTL80343";
  const opName = (nameInput ? nameInput.value : "").trim() || "Aun";

  const btn = document.getElementById("loginSubmitBtn");
  const loginScreen = document.getElementById("pinLoginScreen");
  const loader = document.getElementById("ciraFullscreenLoader");
  const phaseText = document.getElementById("loaderPhaseText");
  const pctNum = document.getElementById("loaderPctNumber");
  const bar = document.getElementById("loaderCyberBar");
  const spinner = document.getElementById("laptopSpinner");
  const check = document.getElementById("laptopCheck");
  const fb = document.getElementById("pinFeedback");

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = "0.7";
    btn.style.cursor = "wait";
  }

  // Smoothly fade out login screen into loader
  if (loginScreen) {
    loginScreen.style.transition = "opacity 0.25s ease";
    loginScreen.style.opacity = "0";
  }

  // Reset and display loader
  if (spinner) spinner.style.display = "block";
  if (check) check.style.display = "none";
  if (bar) {
    bar.style.width = "0%";
    bar.style.background = "linear-gradient(90deg, #d60525 0%, #e60012 50%, #ff3b53 100%)";
  }
  if (pctNum) {
    pctNum.textContent = "0%";
    pctNum.style.color = "#e60012";
  }
  if (phaseText) {
    phaseText.textContent = "กำลังเชื่อมต่อระบบและถ่ายโอนข้อมูล...";
    phaseText.style.color = "#1e293b";
  }

  if (loader) {
    loader.style.display = "flex";
    void loader.offsetWidth;
    loader.classList.remove("closing");
    loader.classList.add("active");
  }

  // Progress Phase 1 (0ms -> 30%)
  if (bar) bar.style.width = "30%";
  if (pctNum) pctNum.textContent = "30%";

  // Trigger login API
  const apiCall = fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operator_id: opId, operator_name: opName })
  })
  .then(res => res.json())
  .catch(() => ({ success: true, operator_id: opId, operator_name: opName }));

  // Progress Phase 2 (300ms -> 70%)
  setTimeout(() => {
    if (bar) bar.style.width = "70%";
    if (pctNum) pctNum.textContent = "70%";
  }, 300);

  // Safety watchdog timer (max 3.0s force finish so user is NEVER stuck)
  const watchdogTimer = setTimeout(() => {
    finishLogin(opId, opName);
  }, 3000);

  function finishLogin(finalId, finalName) {
    clearTimeout(watchdogTimer);
    if (spinner) spinner.style.display = "none";
    if (check) check.style.display = "block";
    if (phaseText) {
      phaseText.textContent = `✓ เชื่อมต่อสำเร็จ ยินดีต้อนรับคุณ ${finalName}`;
      phaseText.style.color = "#059669";
    }
    if (bar) {
      bar.style.width = "100%";
      bar.style.background = "#10b981";
    }
    if (pctNum) {
      pctNum.textContent = "100%";
      pctNum.style.color = "#059669";
    }

    setTimeout(() => {
      if (loader) {
        loader.classList.add("closing");
        setTimeout(() => {
          loader.classList.remove("active", "closing");
          loader.style.display = "none";
        }, 300);
      }
      window.isOperatorLoginRunning = false;
      completeLoginSuccess(finalId, finalName, true);
    }, 350);
  }

  // When API returns, smoothly finish
  setTimeout(() => {
    apiCall.then(data => {
      if (data && data.success === false) {
        clearTimeout(watchdogTimer);
        window.isOperatorLoginRunning = false;
        if (phaseText) {
          phaseText.textContent = data.error || "รหัสพนักงานไม่ถูกต้อง";
          phaseText.style.color = "#ef4444";
        }
        setTimeout(() => {
          if (loader) {
            loader.classList.add("closing");
            setTimeout(() => {
              loader.classList.remove("active", "closing");
              loader.style.display = "none";
              if (loginScreen) {
                loginScreen.style.opacity = "1";
              }
              if (btn) {
                btn.disabled = false;
                btn.style.opacity = "1";
                btn.style.cursor = "pointer";
              }
              if (fb) {
                fb.style.color = "#ef4444";
                fb.textContent = data.error || "รหัสพนักงานไม่ถูกต้อง";
              }
            }, 250);
          }
        }, 700);
        return;
      }

      const finalId = (data && data.operator_id) || opId;
      const finalName = (data && data.operator_name) || opName;
      finishLogin(finalId, finalName);
    });
  }, 650);
}

function quickLoginDirect() {
  const defaultOp = "MTL80343";
  const defaultName = "Aun";
  completeLoginSuccess(defaultOp, defaultName);
}

function skipLoginToDashboard() {
  const loader = document.getElementById("ciraFullscreenLoader");
  if (loader) {
    loader.classList.remove("active", "closing");
    loader.style.display = "none";
  }
  completeLoginSuccess("MTL80343", "Aun", true);
}

function completeLoginSuccess(opId, opName = "Aun", openSetup = true) {
  sessionStorage.setItem("cira_pin_auth", "true");
  sessionStorage.setItem("cira_operator_id", opId);
  sessionStorage.setItem("cira_operator_name", opName);
  if (headerOperator) headerOperator.textContent = opId;
  if (headerOperatorName) headerOperatorName.textContent = `(${opName})`;

  const pinLoginScreen = document.getElementById("pinLoginScreen");
  if (pinLoginScreen) {
    pinLoginScreen.classList.add("logged-in");
    pinLoginScreen.style.setProperty("display", "none", "important");
  }

  addNotification("เข้าสู่ระบบสำเร็จ", `ยินดีต้อนรับคุณ ${opName} (${opId})`, "info");
  if (openSetup) {
    setTimeout(() => {
      openPreLotModal(false);
    }, 200);
  }
}

function pressPinKey(digit) {
  if (enteredPin.length < 6) {
    enteredPin += digit;
    updatePinDots();
    if (enteredPin.length === 6) {
      setTimeout(verifyPin, 150);
    }
  }
}

function backspacePin() {
  if (enteredPin.length > 0) {
    enteredPin = enteredPin.slice(0, -1);
    updatePinDots();
  }
}

function clearPin() {
  enteredPin = "";
  updatePinDots();
  if (pinFeedback) pinFeedback.textContent = "";
}

function updatePinDots() {
  for (let i = 0; i < 6; i++) {
    const dot = document.getElementById(`dot${i}`);
    if (!dot) continue;
    dot.classList.remove("error");
    if (i < enteredPin.length) {
      dot.classList.add("filled");
    } else {
      dot.classList.remove("filled");
    }
  }
}

function verifyPin() {
  const pinToTest = enteredPin || "123456";
  if (pinFeedback) {
    pinFeedback.style.color = "#38bdf8";
    pinFeedback.textContent = "กำลังตรวจสอบ PIN...";
  }

  fetch("/api/auth/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: pinToTest })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      completeLoginSuccess(data.operator_id || "MTL80343");
    } else {
      showPinError(data.error || "รหัส PIN ไม่ถูกต้อง (ค่าเริ่มต้น 123456)");
    }
  })
  .catch(() => {
    // If backend unreachable, verify local fallback
    if (pinToTest === "123456" || pinToTest.length >= 4) {
      completeLoginSuccess("MTL80343");
    } else {
      showPinError("เกิดข้อผิดพลาดในการตรวจสอบ PIN");
    }
  });
}

function showPinError(msg) {
  for (let i = 0; i < 6; i++) {
    const dot = document.getElementById(`dot${i}`);
    if (dot) dot.classList.add("error");
  }
  if (pinFeedback) {
    pinFeedback.style.color = "#ef4444";
    pinFeedback.textContent = msg;
  }
  setTimeout(() => {
    clearPin();
  }, 1200);
}

function lockToPin() {
  sessionStorage.removeItem("cira_pin_auth");
  clearPin();
  const opInput = document.getElementById("loginOperatorInput");
  const pwdInput = document.getElementById("loginPasswordInput");
  const fb = document.getElementById("pinFeedback");
  if (fb) fb.textContent = "";
  if (pinLoginScreen) {
    pinLoginScreen.classList.remove("logged-in");
    pinLoginScreen.style.removeProperty("display");
    pinLoginScreen.style.display = "flex";
    pinLoginScreen.style.opacity = "1";
    pinLoginScreen.style.transform = "scale(1)";
  }
  setTimeout(() => {
    if (opInput) {
      opInput.focus();
      opInput.select();
    }
  }, 100);
}

// ---------------- WebSocket Connection ----------------
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (connDot) {
      connDot.classList.remove("alarm");
      connDot.style.background = "#10b981";
    }
    if (connText) connText.textContent = "ออนไลน์ (Online)";
    if (liveFeedImg && !liveFeedImg.src.startsWith("data:")) {
      liveFeedImg.src = "/video_feed?t=" + Date.now();
    }
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "STATE_UPDATE") {
        updateUI(data);
      }
    } catch (e) {
      console.error("WS Parse Error:", e);
    }
  };

  ws.onclose = () => {
    pollTelemetryFallback();
    setTimeout(connectWebSocket, 3000);
  };
}

let pollInterval = null;
function pollTelemetryFallback() {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    fetch("/api/telemetry")
      .then(res => res.json())
      .then(data => {
        if (connDot) {
          connDot.classList.remove("alarm");
          connDot.style.background = "#10b981";
        }
        if (connText) connText.textContent = "ออนไลน์ (HTTP Sync)";
        updateUI(data);
      })
      .catch(() => {
        if (connDot) connDot.classList.add("alarm");
        if (connText) connText.textContent = "ขาดการเชื่อมต่อ";
      });
  }, 1000);
}

// ---------------- UI Telemetry Updater ----------------
function startReturnToStage2Timer() {
  if (window.returnToScanTimerRunning) return;
  if (currentLotData && currentLotData.state !== "READY" && currentLotData.state !== "LOT_COMPLETE" && currentLotData.state !== "IDLE") {
    return;
  }
  window.returnToScanTimerRunning = true;

  const camOverlay = document.getElementById("camCountdownOverlay");
  const camTitle = document.getElementById("camCountdownTitleText");
  const camSec = document.getElementById("camCountdownSec");
  const camBar = document.getElementById("camCountdownBar");
  const camSub = document.getElementById("camCountdownSubtext");

  const realDone = getRealInspectedBoxes().length;
  const currentDone = realDone || currentLotData?.lot_summary?.inspections_total || 0;
  const targetB = currentLotData?.total_target_boxes || currentRegBoxes.length || 3;
  const isNowDone = (targetB > 0 && currentDone >= targetB);

  let retRem = 2.0;
  const totalRet = 2.0;
  if (camOverlay) {
    camOverlay.style.display = "flex";
    camOverlay.className = "cam-countdown-overlay pass";
  }
  if (camTitle) {
    camTitle.textContent = isNowDone
      ? `✓ บันทึกผลสำเร็จ (ตรวจครบ ${currentDone}/${targetB} กล่อง)`
      : "✓ บันทึกภาพและข้อมูลเรียบร้อย";
  }
  if (camSub) {
    camSub.textContent = isNowDone
      ? "⏱ หน่วง 2 วินาทีเพื่อกลับสู่หน้าสรุปผลการตรวจสอบ (รอพนักงานกดปิดล็อต)..."
      : "⏱ หน่วง 2 วินาทีเพื่อกลับสู่หน้าสรุปผลและสแกนกล่องใหม่...";
  }
  if (camSec) camSec.textContent = retRem.toFixed(1);
  if (camBar) camBar.style.width = "100%";

  if (window.returnIntervalId) clearInterval(window.returnIntervalId);
  window.returnIntervalId = setInterval(() => {
    // If during return delay, system enters DELAY_MOTION or INSPECTING or ALARM_NG, immediately cancel return timer!
    if (currentLotData && (currentLotData.state === "DELAY_MOTION" || currentLotData.state === "INSPECTING" || currentLotData.state === "ALARM_NG")) {
      clearInterval(window.returnIntervalId);
      window.returnIntervalId = null;
      window.returnToScanTimerRunning = false;
      return;
    }

    retRem = Math.max(0, retRem - 0.1);
    const p = Math.max(0, Math.min(100, Math.round((retRem / totalRet) * 100)));
    if (camSec) camSec.textContent = retRem.toFixed(1);
    if (camBar) camBar.style.width = `${p}%`;

    if (retRem <= 0.05) {
      clearInterval(window.returnIntervalId);
      window.returnIntervalId = null;
      window.returnToScanTimerRunning = false;
      if (camOverlay) camOverlay.style.display = "none";
      // Re-open screen 2 in Stage 2 (Inspection Mode) with full inspected table!
      openLotRegScreen(true, true);
    }
  }, 100);
}

function updateUI(data) {
  currentLotData = data;

  // Header info
  if (headerOperator) headerOperator.textContent = data.operator_id;
  const opName = data.operator_name || sessionStorage.getItem("cira_operator_name") || "Aun";
  if (headerOperatorName) headerOperatorName.textContent = `(${opName})`;
  if (headerLot) headerLot.textContent = data.lot_number;
  if (headerModel && data.part_model) {
    const shortModel = data.part_model.split(" ")[0] || data.part_model;
    headerModel.textContent = shortModel;
  }

  // Registered Boxes & Current Target Box
  const regBoxes = (data.registered_boxes && data.registered_boxes.length > 0) ? data.registered_boxes : currentRegBoxes;
  const isClosed = (data.state === "LOT_CLOSED");
  const summary = isClosed ? {} : (data.lot_summary || {});
  const qtyPerBox = data.qty_per_box || 700;
  const goodBoxes = isClosed ? 0 : (summary.good_boxes || 0);
  const ngBoxes = isClosed ? 0 : (summary.ng_boxes || 0);
  const totalInspected = isClosed ? 0 : (summary.inspections_total || 0);
  const targetBoxes = data.total_target_boxes || (regBoxes ? regBoxes.length : 3);
  const currentOutputQty = isClosed ? 0 : (summary.output_qty ?? (data.output_qty ?? (goodBoxes * qtyPerBox)));
  const currentDefectQty = isClosed ? 0 : (summary.defect_qty ?? (ngBoxes * qtyPerBox));
  const totalWorkTarget = data.total_work_qty || 2000;
  const isLotFinished = isClosed || (targetBoxes > 0 && totalInspected >= targetBoxes && totalInspected > 0) || (totalWorkTarget > 0 && currentOutputQty >= totalWorkTarget && totalInspected > 0) || (data.state === "LOT_COMPLETE");

  const currentRegBox = (regBoxes && regBoxes.length > totalInspected) ? regBoxes[totalInspected] : null;
  const nextBoxBarcode = data.next_box_barcode || (currentRegBox ? currentRegBox.box_no : "");
  const isCarryoverBox = currentRegBox && (currentRegBox.is_carryover || currentRegBox.leftover_qty);
  const carryoverQty = isCarryoverBox ? (currentRegBox.leftover_qty || 100) : 0;
  const boxDisplayStr = isCarryoverBox ? `${nextBoxBarcode} (งานเศษเหลือ ${carryoverQty} ชิ้น)` : nextBoxBarcode;
  const currentBoxDisplayNum = Math.min(totalInspected + 1, targetBoxes);

  // Box Barcode Display Strip
  if (viewBoxBarcode) {
    if (data.state === "DUMMY_TEST") {
      viewBoxBarcode.innerHTML = `<span style="color: #fbbf24;">(ขั้นตอน Poka-Yoke) กรุณาทดสอบ Dummy Test ให้ผ่านครบทั้ง 2 ชิ้น</span>`;
    } else if (data.state === "ALARM_NG") {
      viewBoxBarcode.innerHTML = `<span style="color: #ef4444; font-weight: 700;">⛔ ตรวจพบชิ้นงาน NG (หยุดชั่วคราว รอ Leader อนุมัติ)</span>`;
    } else if (data.need_more_boxes) {
      viewBoxBarcode.innerHTML = `<span style="color: #f59e0b; font-weight: 700;">⚠️ กล่องไม่พอสำหรับยอดงาน ${data.total_work_qty || 2000} ชิ้น (ปัจจุบันได้ ${currentOutputQty} ชิ้น - ขาดอีก ${data.work_remaining_qty || 0} ชิ้น) ➔ กรุณาสแกนกล่องใหม่</span>`;
    } else if (isLotFinished) {
      viewBoxBarcode.innerHTML = `<span style="color: #10b981; font-weight: 700;">✔ ตรวจครบตามเป้าหมายของล็อตแล้ว (${currentOutputQty}/${data.total_work_qty || 2000} ชิ้น)</span>`;
    } else if (data.state === "DELAY_MOTION" || data.state === "INSPECTING" || data.state === "RESULT_HOLD") {
      const activeBox = data.current_box_barcode || nextBoxBarcode || "กำลังตรวจสอบ";
      const activeDisplay = (isCarryoverBox && activeBox === nextBoxBarcode) ? boxDisplayStr : activeBox;
      viewBoxBarcode.innerHTML = `<strong style="color: #f8fafc;">${activeDisplay}</strong> <span style="color: #fbbf24; font-size: 13px; font-weight: normal; margin-left: 6px;">(กำลังตรวจจับ AI กล่องที่ ${currentBoxDisplayNum}/${targetBoxes})</span>`;
    } else if (nextBoxBarcode) {
      if (isCarryoverBox) {
        viewBoxBarcode.innerHTML = `<strong style="color: #f59e0b;">${boxDisplayStr}</strong> <span style="color: #94a3b8; font-size: 13px; font-weight: normal; margin-left: 6px;">(พร้อมตรวจกล่องที่ ${currentBoxDisplayNum}/${targetBoxes})</span>`;
      } else {
        viewBoxBarcode.innerHTML = `<strong style="color: #38bdf8;">${nextBoxBarcode}</strong> <span style="color: #94a3b8; font-size: 13px; font-weight: normal; margin-left: 6px;">(พร้อมตรวจกล่องที่ ${currentBoxDisplayNum}/${targetBoxes})</span>`;
      }
    } else {
      viewBoxBarcode.textContent = `พร้อมสแกนกล่องที่ ${currentBoxDisplayNum}`;
    }
  }

  // Update Barcode Input prompt for need_more_boxes
  const bInput = document.getElementById("barcodeInput");
  if (bInput) {
    if (data.need_more_boxes) {
      bInput.placeholder = `⚠️ กล่องไม่พอ (ขาดอีก ${data.work_remaining_qty || 0} ชิ้น) กรุณายิงหรือพิมพ์บาร์โค้ดกล่องถัดไปแล้วกด Enter...`;
      bInput.style.borderColor = "#f59e0b";
      bInput.style.boxShadow = "0 0 10px rgba(245, 158, 11, 0.4)";
    } else {
      bInput.placeholder = "ยิงหรือพิมพ์บาร์โค้ดกล่องงาน (เช่น BX-001) แล้วกด Enter";
      bInput.style.removeProperty("border-color");
      bInput.style.removeProperty("box-shadow");
    }
  }

  // Update Relays & Tower Lamp Visualizer
  if (window.vHw) {
    window.vHw.updateRelays(data.relays);
  }

  // Dummy Test Status
  if (data.dummy_status) {
    if (data.dummy_status.good_passed && btnDummyGood) {
      btnDummyGood.style.background = "#059669";
      btnDummyGood.style.boxShadow = "0 0 10px rgba(16, 185, 129, 0.4)";
    }
    if (data.dummy_status.ng_passed && btnDummyNG) {
      btnDummyNG.style.background = "#dc2626";
      btnDummyNG.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.4)";
    }
    if (currentLotData) {
      currentLotData.dummy_status = data.dummy_status;
      currentLotData.dummy_tested = data.dummy_tested;
    }
    updateStage2DummyStatus(data.dummy_status, data.dummy_tested);
  }

  // KPI Statistics
  if (statBoxesDone) statBoxesDone.textContent = totalInspected;
  if (statTargetBoxes) statTargetBoxes.textContent = targetBoxes;
  if (statGoodPieces) statGoodPieces.textContent = `${currentOutputQty} ชิ้น`;
  if (statDefectPieces) statDefectPieces.textContent = `${currentDefectQty} ชิ้น`;

  // Yield Rate & Donut Progress Ring
  let yieldVal = 100.0;
  if (!isClosed && totalInspected > 0) {
    yieldVal = ((goodBoxes / totalInspected) * 100).toFixed(1);
  }
  if (statYieldRate) statYieldRate.textContent = `${yieldVal}%`;

  if (donutProgressCircle) {
    // Circumference = 2 * PI * 14 ≈ 88
    const offset = 88 - (88 * (parseFloat(yieldVal) / 100));
    donutProgressCircle.style.strokeDashoffset = offset;
    donutProgressCircle.style.stroke = parseFloat(yieldVal) >= 98.0 ? "#10b981" : "#ef4444";
  }

  // Lot Progress Bar Card
  if (progressBoxesText) progressBoxesText.textContent = `${totalInspected} / ${targetBoxes}`;
  const pct = (!isClosed && targetBoxes > 0) ? Math.min(100, Math.round((totalInspected / targetBoxes) * 100)) : 0;
  if (progressPctText) progressPctText.textContent = `${pct}%`;
  if (lotProgressBar) lotProgressBar.style.width = `${pct}%`;

  // Alarm & Bypass Buttons
  if (data.active_alarm) {
    if (btnBypass) btnBypass.style.display = "inline-flex";
    if (btnClearAlarm) btnClearAlarm.style.display = "inline-flex";
  } else {
    if (btnBypass) btnBypass.style.display = "none";
    if (btnClearAlarm) btnClearAlarm.style.display = "none";
  }

  // Machine Vision Result Header
  if (hmiStatusBar) {
    hmiStatusBar.className = "ai-result-signboard";

    if (data.state === "DUMMY_TEST") {
      hmiStatusBar.classList.add("warn");
      setSignIcon("warn");
      if (statusHeadline) statusHeadline.textContent = "บังคับทดสอบชิ้นงานตัวอย่าง (DUMMY TEST POKA-YOKE)";
      if (statusCaption) statusCaption.textContent = "ระบบล็อกการสแกนกล่อง: กรุณากดทดสอบ Dummy Good และ Dummy NG ให้ผ่านครบก่อนเริ่มตรวจงานจริง";
      if (statusConf) statusConf.textContent = "LOCK";
    } else if (data.state === "DELAY_MOTION") {
      hmiStatusBar.classList.add("warn");
      setSignIcon("warn");
      if (statusHeadline) statusHeadline.textContent = `กำลังหน่วงเวลาป้องกันภาพสั่น (${data.delay_remaining_sec}s)`;
      if (statusCaption) statusCaption.textContent = "ระบบหยุดนิ่ง Poka-Yoke 2 วินาที เพื่อความคมชัดของภาพชิ้นงานก่อนประมวลผล Deep Learning";
      if (statusConf) statusConf.textContent = "--";
    } else if (data.state === "INSPECTING") {
      hmiStatusBar.classList.add("standby");
      setSignIcon("standby");
      if (statusHeadline) statusHeadline.textContent = "CiRA CORE กำลังประมวลผลการตรวจสอบ...";
      if (statusCaption) statusCaption.textContent = "ระบบ AI Deep Learning กำลังจำแนกทิศทางการวางชิ้นงานและเทปปิดทับ";
      if (statusConf) statusConf.textContent = "...";
    } else if (data.state === "RESULT_HOLD") {
      const isGood = data.evaluating_result ? (data.evaluating_result === "G") : (data.last_inspection && data.last_inspection.result === "G");
      hmiStatusBar.classList.add(isGood ? "pass" : "fail");
      setSignIcon(isGood ? "pass" : "fail");
      const rem = typeof data.delay_remaining_sec === "number" ? data.delay_remaining_sec : 3.0;
      if (statusHeadline) {
        statusHeadline.textContent = isGood
          ? `ผลตรวจ: ชิ้นงานถูกต้อง (G) ⏱ นับเวลาค้าง [ ${rem.toFixed(1)}s ] ➡ บันทึกภาพ`
          : `ผลตรวจ: ข้อผิดพลาด (NG) ⏱ นับเวลาค้าง [ ${rem.toFixed(1)}s ] ➡ บันทึกภาพ`;
      }
      if (statusCaption) {
        statusCaption.textContent = "ระบบกำลังแสดงผลภาพการตรวจจับ 3 วินาทีตามข้อกำหนด เมื่อครบกำหนดเวลาจะทำการบันทึกภาพถ่ายและประวัติลงฐานข้อมูลทันที";
      }
      if (statusConf) {
        statusConf.textContent = data.last_inspection?.confidence ? `${data.last_inspection.confidence.toFixed(1)}%` : "--";
      }

      // Display high-definition inspected image directly to eliminate black screen
      if (liveFeedImg && data.last_inspection && data.last_inspection.image_base64) {
        liveFeedImg.src = "data:image/jpeg;base64," + data.last_inspection.image_base64;
      }
    } else if (data.state === "ALARM_NG") {
      hmiStatusBar.classList.add("fail");
      setSignIcon("fail");
      if (statusHeadline) statusHeadline.textContent = "ระบบล็อกการทำงาน: ตรวจพบข้อผิดพลาด (ALARM NG)";
      if (statusCaption) statusCaption.textContent = "สัญญาณเตือนดังขึ้น ไม่อนุญาตให้ตรวจจับงานต่อ กรุณาติดต่อหัวหน้างาน (LEADER) เพื่อยืนยันสิทธิ์อนุมัติข้ามกล่อง";
      if (statusConf) statusConf.textContent = data.last_inspection?.confidence ? `${data.last_inspection.confidence.toFixed(1)}%` : "NG";

      // Display high-definition NG defect image directly
      if (liveFeedImg && data.last_inspection && data.last_inspection.image_base64) {
        liveFeedImg.src = "data:image/jpeg;base64," + data.last_inspection.image_base64;
      }
    } else if (data.state === "LOT_COMPLETE") {
      hmiStatusBar.classList.add("pass");
      setSignIcon("pass");
      if (statusHeadline) statusHeadline.textContent = `⛔ ตรวจครบตามเป้าหมายของล็อตแล้ว (${totalInspected}/${targetBoxes} กล่อง) - ระบบล็อก บังคับปิดล็อตการผลิต`;
      if (statusCaption) statusCaption.textContent = "ผลิตและตรวจครบตามจำนวนเป้าหมายแล้ว ระบบบล็อกการตรวจจับทุกกรณี กรุณากดยืนยันปิดล็อตการผลิตเพื่อส่งข้อมูลเข้าระบบ";
      if (statusConf) statusConf.textContent = "100%";
    } else if (data.last_inspection) {
      const res = data.last_inspection.result;
      const conf = data.last_inspection.confidence || 99.0;
      const isBypassed = data.last_inspection.is_bypassed;

      if (res === "G") {
        hmiStatusBar.classList.add("pass");
        setSignIcon("pass");
        if (statusHeadline) {
          statusHeadline.textContent = isBypassed 
            ? `ผลตรวจ: G (หลีดเดอร์อนุมัติโดย ${data.last_inspection.bypassed_by || 'LEADER-01'})`
            : "ผลตรวจ: ชิ้นงานถูกต้อง (G)";
        }
        if (statusCaption) {
          statusCaption.textContent = isBypassed
            ? "ได้รับการยืนยันผลตรวจจาก AI ตาม Flowchart"
            : "การบรรจุชิ้นงานถูกต้องตามมาตรฐาน ไม่พบการกลับทิศทางหรือเทปปิดทับ";
        }
        if (statusConf) statusConf.textContent = `${conf.toFixed(1)}%`;
      } else {
        hmiStatusBar.classList.add("fail");
        setSignIcon("fail");
        if (statusHeadline) statusHeadline.textContent = "ผลตรวจ: ข้อผิดพลาด (NG: ใส่กลับด้าน/มีเทป)";
        if (statusCaption) statusCaption.textContent = "สัญญาณเตือนดังขึ้น กรุณาติดต่อหัวหน้างานเพื่อขออนุมัติข้ามกล่อง";
        if (statusConf) statusConf.textContent = `${conf.toFixed(1)}%`;
      }
    } else {
      hmiStatusBar.classList.add("standby");
      setSignIcon("standby");
      if (statusHeadline) statusHeadline.textContent = "พร้อมปฏิบัติงาน (READY TO SCAN)";
      if (statusCaption) statusCaption.textContent = "ยิงหรือพิมพ์บาร์โค้ดกล่องงานเพื่อเริ่มกระบวนการตรวจจับด้วย CiRA AI";
      if (statusConf) statusConf.textContent = "--";
    }
  }

  // Restore live stream when in READY / DUMMY_TEST / DELAY_MOTION
  if (liveFeedImg && (data.state === "READY" || data.state === "DUMMY_TEST" || data.state === "DELAY_MOTION" || data.state === "INSPECTING")) {
    if (liveFeedImg.src.startsWith("data:") || liveFeedImg.naturalWidth === 0) {
      liveFeedImg.src = "/video_feed?t=" + Date.now();
    }
  }




  // Synchronize currentInspectedBoxes from database inspections
  const defaultCam = (document.getElementById("regInspectionNo")?.value || "").trim() || (currentLotData?.inspection_no || "CAM-01");
  const defaultOp = (document.getElementById("regOperatorNameDisplay")?.textContent || "").trim() || (currentLotData?.operator_name || "Sitthichok Suriyawong");

  if (data.lot_summary && Array.isArray(data.lot_summary.inspections)) {
    data.lot_summary.inspections.forEach((dbInsp, idx) => {
      const bCode = dbInsp.box_barcode;
      if (!bCode) return;
      const res = (dbInsp.final_result || dbInsp.ai_result || "G").toUpperCase();
      const formatTime = (ts) => {
        if (!ts) return "--";
        try {
          const d = new Date(ts);
          if (isNaN(d.getTime())) return ts;
          const pad = n => String(n).padStart(2, '0');
          return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch(e) {
          return ts;
        }
      };
      const existing = currentInspectedBoxes.find(b => String(b.box_no || "").toUpperCase() === String(bCode || "").toUpperCase());
      if (!existing) {
        currentInspectedBoxes.push({
          cam_no: defaultCam,
          ins_no: dbInsp.box_index || (idx + 1),
          box_no: bCode,
          result: res,
          time: formatTime(dbInsp.created_at),
          operator: dbInsp.bypassed_by ? `${dbInsp.bypassed_by} (อนุมัติ: ${res})` : (dbInsp.operator_id || defaultOp)
        });
      } else {
        existing.result = res;
        if (dbInsp.bypassed_by) {
          existing.operator = `${dbInsp.bypassed_by} (อนุมัติ: ${res})`;
        }
      }
    });
  }

  // Record single last_inspection to currentInspectedBoxes in Stage 2
  if (data.last_inspection && data.last_inspection.box_barcode && (data.state === "RESULT_HOLD" || data.state === "READY" || data.state === "DUMMY_TEST")) {
    const insp = data.last_inspection;
    const bCode = insp.box_barcode;
    const res = (insp.result || "G").toUpperCase();
    const existing = currentInspectedBoxes.find(b => String(b.box_no || "").toUpperCase() === String(bCode || "").toUpperCase());
    const nowTime = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timeStr = `${pad(nowTime.getDate())}/${pad(nowTime.getMonth() + 1)}/${nowTime.getFullYear()} ${pad(nowTime.getHours())}:${pad(nowTime.getMinutes())}:${pad(nowTime.getSeconds())}`;

    if (!existing) {
      currentInspectedBoxes.push({
        cam_no: defaultCam,
        ins_no: insp.box_index || (currentInspectedBoxes.length + 1),
        box_no: bCode,
        result: res,
        time: insp.timestamp ? insp.timestamp : timeStr,
        operator: defaultOp
      });
    } else {
      existing.result = res;
    }
  }

  if (isCurrentInStage2) {
    renderRegTable();
  }

  // Update Stage 2 stats
  updateStage2Stats();

  // Cancel return timer immediately if a new scan or alarm begins
  if (data.state === "DELAY_MOTION" || data.state === "INSPECTING" || data.state === "ALARM_NG") {
    if (window.returnIntervalId) {
      clearInterval(window.returnIntervalId);
      window.returnIntervalId = null;
    }
    window.returnToScanTimerRunning = false;
    const camOverlay = document.getElementById("camCountdownOverlay");
    if (camOverlay && data.state !== "RESULT_HOLD" && data.state !== "DELAY_MOTION") {
      camOverlay.style.display = "none";
    }
  }

  // Track state transitions to auto-return to Scan Modal after 3s hold & save
  const prevState = window.lastTrackedSystemState || null;
  window.lastTrackedSystemState = data.state;

  if (data.state === "RESULT_HOLD") {
    window.hasResultHoldPending = true;
  } else if (data.state === "ALARM_NG") {
    window.hasResultHoldPending = false;
  }

  if ((window.hasResultHoldPending || prevState === "RESULT_HOLD") && (data.state === "READY" || data.state === "LOT_COMPLETE" || data.state === "IDLE")) {
    window.hasResultHoldPending = false;
    startReturnToStage2Timer();
  }

  if (data.state !== "ALARM_NG") {
    window.bypassModalLockedClosed = false;
  }
  // Auto-pop Leader Bypass Modal ONLY ON TRANSITION into ALARM_NG (prevents infinite re-opening loop)
  if (prevState !== "ALARM_NG" && data.state === "ALARM_NG" && !window.bypassModalLockedClosed) {
    window.leaderBypassSubmitted = false;
    openBypassModal();
  }

  // Camera Viewport HUD Countdown Overlay (3.0s Hold Timer)
  const camCountdownOverlay = document.getElementById("camCountdownOverlay");
  const camCountdownTitleText = document.getElementById("camCountdownTitleText");
  const camCountdownSec = document.getElementById("camCountdownSec");
  const camCountdownBar = document.getElementById("camCountdownBar");
  const camCountdownSubtext = document.getElementById("camCountdownSubtext");

  if (data.state === "RESULT_HOLD") {
    const isGood = data.evaluating_result ? (data.evaluating_result === "G") : (data.last_inspection && data.last_inspection.result === "G");
    const rem = typeof data.delay_remaining_sec === "number" ? data.delay_remaining_sec : 3.0;
    const totalHold = 3.0;
    const pct = Math.max(0, Math.min(100, Math.round((rem / totalHold) * 100)));

    if (camCountdownOverlay) {
      camCountdownOverlay.style.display = "flex";
      camCountdownOverlay.className = `cam-countdown-overlay ${isGood ? "pass" : "fail"}`;
    }
    if (camCountdownTitleText) {
      camCountdownTitleText.textContent = isGood 
        ? "ตรวจผ่าน [G] - กำลังแสดงผลค้างไว้ 3 วินาที" 
        : "ไม่ผ่าน [NG] - กำลังแสดงผลค้างไว้ 3 วินาที";
    }
    if (camCountdownSec) {
      camCountdownSec.textContent = rem.toFixed(1);
    }
    if (camCountdownBar) {
      camCountdownBar.style.width = `${pct}%`;
    }
    if (camCountdownSubtext) {
      camCountdownSubtext.textContent = "⏱ หน่วง 3 วินาที ➔ บันทึกภาพและเก็บข้อมูลลงระบบอัตโนมัติ";
    }
  } else if (data.state === "DELAY_MOTION") {
    const rem = typeof data.delay_remaining_sec === "number" ? data.delay_remaining_sec : 2.0;
    const totalDelay = 2.0;
    const pct = Math.max(0, Math.min(100, Math.round((rem / totalDelay) * 100)));

    if (camCountdownOverlay) {
      camCountdownOverlay.style.display = "flex";
      camCountdownOverlay.className = "cam-countdown-overlay warn";
    }
    if (camCountdownTitleText) {
      camCountdownTitleText.textContent = "หน่วงเวลา 2 วินาทีเพื่อเช็ค G / NG (ป้องกันภาพสั่น)";
    }
    if (camCountdownSec) {
      camCountdownSec.textContent = rem.toFixed(1);
    }
    if (camCountdownBar) {
      camCountdownBar.style.width = `${pct}%`;
    }
    if (camCountdownSubtext) {
      camCountdownSubtext.textContent = "🔍 ระบบกำลังประมวลผลการจัดวางชิ้นงานด้วย CiRA CORE Image AI...";
    }
  } else {
    if (!window.startupCountdownRunning && !window.returnToScanTimerRunning && camCountdownOverlay) {
      camCountdownOverlay.style.display = "none";
    }
  }

// Continuous ALARM_NG auto-pop replaced by transition trigger above

  // Check if current lot is finished (3/3 boxes completed)
  const isLocked = (data.state === "ALARM_NG" || isLotFinished);

  // Auto-pop Lot Close Modal disabled by user request:
  // "เมื่อครบกล่องสุดท้ายยังไม่ต้องบังคับปิด lot ให้เด้งมาหน้าที่2ก่อน เเล้วให้พนักกดปิดล็อตเอง"
  // The system returns to Stage 2 instead, allowing the operator to verify results and click [ ปิดล๊อต ] manually.

  // Toggle Force Close Lot button
  const btnForceCloseLot = document.getElementById("btnForceCloseLot");
  if (btnForceCloseLot) {
    btnForceCloseLot.style.display = isLotFinished ? "inline-flex" : "none";
    btnForceCloseLot.onclick = () => openLotRegScreen(true, true);
  }

  // Lock or unlock inputs during ALARM_NG or LOT_COMPLETE
  const btnScan = document.getElementById("btnScan");
  if (btnScan) {
    btnScan.disabled = isLocked;
    btnScan.style.opacity = isLocked ? "0.35" : "1";
    btnScan.style.cursor = isLocked ? "not-allowed" : "pointer";
  }

  document.querySelectorAll(".sim-btn").forEach(btn => {
    btn.disabled = isLocked;
    btn.style.opacity = isLocked ? "0.35" : "1";
    btn.style.cursor = isLocked ? "not-allowed" : "pointer";
  });

  if (barcodeInput) {
    if (data.state === "ALARM_NG") {
      barcodeInput.disabled = true;
      barcodeInput.placeholder = "⛔ ระบบล็อก: รอนุมัติโดยหัวหน้างาน (Leader)";
    } else if (isLotFinished) {
      barcodeInput.disabled = true;
      barcodeInput.value = "";
      barcodeInput.placeholder = `✔ ตรวจครบ ${totalInspected}/${targetBoxes} กล่องแล้ว: บังคับปิดล็อตการผลิต`;
    } else if (data.state === "DUMMY_TEST") {
      barcodeInput.disabled = false;
      if (nextBoxBarcode) {
        barcodeInput.value = nextBoxBarcode;
      }
      barcodeInput.placeholder = "⚠ กรุณาทดสอบ Dummy ก่อนตรวจกล่องงานจริง";
    } else if (data.state === "DELAY_MOTION" || data.state === "INSPECTING" || data.state === "RESULT_HOLD") {
      barcodeInput.disabled = true;
      if (data.current_box_barcode) {
        barcodeInput.value = data.current_box_barcode;
      }
    } else {
      barcodeInput.disabled = false;
      if (nextBoxBarcode) {
        barcodeInput.value = nextBoxBarcode;
        barcodeInput.placeholder = `กล่องที่ ${currentBoxDisplayNum}: ${nextBoxBarcode}`;
      } else {
        barcodeInput.placeholder = "สแกนบาร์โค้ดกล่องงาน (เช่น BX-001)";
      }
    }
  }

  // Update Giant HMI Decision Result Card
  updateBigDecisionCard(data);

  // Refresh inspections list and per-box chart
  loadTraceabilityData(false);
}

// ---------------- Giant HMI Decision Result Display Card (Pure N / NG) ----------------
let lastCompletedBoxResult = null;

function updateBigDecisionCard(data) {
  const card = document.getElementById("bigDecisionCard");
  const symbolText = document.getElementById("decisionSymbolText");

  if (!card || !symbolText) return;

  const isLotClosed = (data.state === "LOT_CLOSED");

  // 1. Reset on Lot Closed
  if (isLotClosed) {
    lastCompletedBoxResult = null;
    card.className = "big-decision-card standby";
    symbolText.textContent = "STANDBY";
    return;
  }

  // 2. Active inspection scanning (DELAY_MOTION / INSPECTING / RESULT_HOLD)
  if (data.state === "DELAY_MOTION" || data.state === "INSPECTING") {
    card.className = "big-decision-card evaluating";
    symbolText.textContent = "...";
    return;
  }
  if (data.state === "RESULT_HOLD") {
    const isGood = data.evaluating_result ? (data.evaluating_result === "G") : (data.last_inspection && data.last_inspection.result === "G");
    card.className = isGood ? "big-decision-card pass" : "big-decision-card fail";
    symbolText.textContent = isGood ? "G" : "NG";
    return;
  }

  // 3. Capture completed inspection result
  if (data.last_inspection && data.last_inspection.result) {
    const insp = data.last_inspection;
    lastCompletedBoxResult = {
      result: insp.result,
      confidence: insp.confidence || 99.0,
      defect_type: insp.defect_type || (insp.result === "G" ? "NONE" : "TAPE_COVERED"),
      box_barcode: insp.box_barcode || data.current_box_barcode || "BOX",
      cycle_time_ms: insp.cycle_time_ms || 2350,
      is_bypassed: Boolean(insp.is_bypassed),
      bypassed_by: insp.bypassed_by || ""
    };
  }

  // 4. Render persistent result if available (Giant G: Green / NG: Red)
  if (lastCompletedBoxResult) {
    const isGood = (lastCompletedBoxResult.result === "G");
    if (isGood) {
      card.className = "big-decision-card pass";
      symbolText.textContent = "G";
    } else {
      card.className = "big-decision-card fail";
      symbolText.textContent = "NG";
    }
    return;
  }

  // 5. Default STANDBY (before box 1 inspection)
  card.className = "big-decision-card standby";
  symbolText.textContent = "STANDBY";
}

function setSignIcon(type) {
  if (!signCircleIcon) return;
  if (type === "pass") {
    signCircleIcon.innerHTML = `<svg style="width: 22px; height: 22px; fill: #ffffff;" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
  } else if (type === "fail") {
    signCircleIcon.innerHTML = `<svg style="width: 22px; height: 22px; fill: #ffffff;" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
  } else if (type === "warn") {
    signCircleIcon.innerHTML = `<svg style="width: 20px; height: 20px; fill: #ffffff;" viewBox="0 0 24 24"><path d="M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4z"/></svg>`;
  } else {
    signCircleIcon.innerHTML = `<svg style="width: 20px; height: 20px; fill: #ffffff;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
  }
}

// ---------------- Barcode Scanner Listener ----------------
function initBarcodeScannerListener() {
  if (!barcodeInput) return;
  barcodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      submitBarcode();
    }
  });
}

function submitBarcode() {
  const isLotFinished = currentLotData && (currentLotData.state === "LOT_COMPLETE" || currentLotData.state === "LOT_CLOSED" || (currentLotData.total_target_boxes > 0 && currentLotData.lot_summary?.inspections_total >= currentLotData.total_target_boxes));
  if (isLotFinished) {
    alert(`⛔ ล็อตนี้ตรวจครบตามเป้าหมายแล้ว (${currentLotData.lot_summary?.inspections_total || 0}/${currentLotData.total_target_boxes} กล่อง)\nระบบบล็อกการตรวจจับ บังคับปิดล็อตการผลิตเท่านั้น!`);
    openLotCloseModal();
    return;
  }
  if (currentLotData && currentLotData.state === "ALARM_NG") {
    alert("⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!");
    openBypassModal();
    return;
  }
  if (currentLotData && currentLotData.state === "DUMMY_TEST" && currentLotData.dummy_sample_required) {
    alert("⚠ Poka-Yoke Lock: บังคับทดสอบชิ้นงานตัวอย่าง (Dummy Test) ทั้ง Good และ NG ให้ผ่านครบก่อนเริ่มสแกนกล่องงานจริง!");
    return;
  }

  let code = (barcodeInput.value || "").trim();
  if (!code) {
    const regBoxes = (currentLotData?.registered_boxes && currentLotData.registered_boxes.length > 0)
      ? currentLotData.registered_boxes
      : currentRegBoxes;
    const doneCount = currentLotData?.lot_summary?.inspections_total || 0;
    if (regBoxes && regBoxes.length > doneCount) {
      code = regBoxes[doneCount].box_no;
    }
  }

  if (!code) {
    alert("กรุณากรอกหรือสแกนบาร์โค้ดประจำกล่อง");
    return;
  }
  barcodeInput.value = "";

  fetch("/api/inspection/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: code })
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      alert(data.error);
      if (currentLotData && currentLotData.state === "ALARM_NG") {
        openBypassModal();
      }
    }
  })
  .catch(err => console.error("Scan error:", err));
}

// ---------------- Inspection Triggers ----------------
function triggerInspection(forceResult) {
  const isLotFinished = currentLotData && (currentLotData.state === "LOT_COMPLETE" || currentLotData.state === "LOT_CLOSED" || (currentLotData.total_target_boxes > 0 && currentLotData.lot_summary?.inspections_total >= currentLotData.total_target_boxes));
  if (isLotFinished) {
    alert(`⛔ ล็อตนี้ตรวจครบตามเป้าหมายแล้ว (${currentLotData.lot_summary?.inspections_total || 0}/${currentLotData.total_target_boxes} กล่อง)\nระบบบล็อกการตรวจจับ บังคับปิดล็อตการผลิตเท่านั้น!`);
    openLotCloseModal();
    return;
  }
  if (currentLotData && currentLotData.state === "ALARM_NG") {
    alert("⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!");
    openBypassModal();
    return;
  }
  if (currentLotData && currentLotData.state === "DUMMY_TEST" && currentLotData.dummy_sample_required) {
    alert("⚠ Poka-Yoke Lock: บังคับทดสอบชิ้นงานตัวอย่าง (Dummy Test) ทั้ง Good และ NG ให้ผ่านครบก่อนเริ่มตรวจสอบ!");
    return;
  }

  // Cancel any active return timers and close registration modal
  if (window.returnIntervalId) {
    clearInterval(window.returnIntervalId);
    window.returnIntervalId = null;
  }
  window.returnToScanTimerRunning = false;
  const camOverlay = document.getElementById("camCountdownOverlay");
  if (camOverlay) camOverlay.style.display = "none";
  closeModal("modalLotRegistration");

  fetch("/api/inspection/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force_result: forceResult })
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      alert(data.error);
      if (currentLotData && currentLotData.state === "ALARM_NG") {
        openBypassModal();
      }
    }
  })
  .catch(err => console.error("Trigger error:", err));
}

function runDummyTest(sampleType) {
  if (currentLotData && currentLotData.state === "ALARM_NG") {
    alert("⛔ งานไม่ผ่าน (NG): ระบบล็อกการทำงาน ต้องให้ LEADER อนุมัติข้ามก่อนเท่านั้น!");
    openBypassModal();
    return;
  }

  fetch("/api/dummy/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sample_type: sampleType })
  })
  .then(res => res.json())
  .then(() => {
    alert(`ทดสอบชิ้นงานตัวอย่าง ${sampleType === 'GOOD_SAMPLE' ? 'Good (G)' : 'NG'} ผ่านเรียบร้อยแล้ว`);
    addNotification("ทดสอบ Dummy Test สำเร็จ", `ตัวอย่าง ${sampleType === 'GOOD_SAMPLE' ? 'Good (G)' : 'Defect (NG)'} ผ่านการตรวจสอบ Poka-Yoke`, "info");
  })
  .catch(err => console.error("Dummy test error:", err));
}

function clearAlarm() {
  fetch("/api/alarm/clear", { method: "POST" })
  .catch(err => console.error(err));
}

// ---------------- Leader Bypass Modal ----------------
function openBypassModal() {
  if (window.leaderBypassSubmitted || window.bypassModalLockedClosed) return;
  const modal = document.getElementById("modalBypass");
  if (!modal) return;
  modal.style.display = "flex";
  modal.classList.add("active");

  const lastInsp = currentLotData?.last_inspection || {};
  const boxBarcode = lastInsp.box_barcode || currentLotData?.current_box_barcode || "ไม่ระบุ";
  const defectType = lastInsp.defect_type || "TAPE_COVERED (ตรวจพบเทปปิดทับ/ชิ้นงานเอียง)";
  const confidence = lastInsp.confidence ? `${Number(lastInsp.confidence).toFixed(1)}%` : "99.2%";

  const boxEl = document.getElementById("bypassBoxBarcodeDisplay");
  const defectEl = document.getElementById("bypassDefectTypeDisplay");
  const confEl = document.getElementById("bypassConfidenceDisplay");
  if (boxEl) boxEl.textContent = boxBarcode;
  if (defectEl) defectEl.textContent = defectType;
  if (confEl) confEl.textContent = confidence;

  const input = document.getElementById("bypassLeaderId");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 150);
  }
}

function submitLeaderDecision(decision) {
  const leaderIdInput = document.getElementById("bypassLeaderId");
  let leaderId = (leaderIdInput ? leaderIdInput.value : "").trim();
  if (!leaderId) {
    leaderId = sessionStorage.getItem("cira_operator_id") || "LEADER-01";
    if (leaderIdInput) leaderIdInput.value = leaderId;
  }

  let reason = "";
  if (decision === "G") {
    reason = document.getElementById("bypassReasonG")?.value || "งานประกอบถูกต้อง AI ตรวจจับผิดพลาดจากแสงเงา (False NG)";
  } else {
    reason = document.getElementById("bypassReasonNG")?.value || "ตรวจพบเทปปิดทับ / ชิ้นงานเอียงผิดตำแหน่งจริง";
  }

  // Prevent auto-reopen and immediately hide modal
  window.leaderBypassSubmitted = true;
  window.bypassModalLockedClosed = true;
  const bypassModal = document.getElementById("modalBypass");
  if (bypassModal) {
    bypassModal.classList.remove("active");
    bypassModal.style.display = "none";
  }

  fetch("/api/bypass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      leader_id: leaderId,
      reason: reason,
      decision: decision
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      alert(`ไม่สามารถยืนยันสิทธิ์ได้: ${data.error}`);
      window.leaderBypassSubmitted = false;
      return;
    }

    const decisionBadge = decision === "G" ? "งานดี [ G ] (False NG Override)" : "งานเสีย [ NG ] (Confirmed NG)";
    addNotification(
      "หัวหน้างานยืนยันสิทธิ์สำเร็จ",
      `หัวหน้างาน ${leaderId} ยืนยันสรุปผลกล่อง ${data.box_barcode || ''} เป็น: ${decisionBadge}`,
      decision === "G" ? "success" : "alarm"
    );

    // Update or add inspected box into currentInspectedBoxes safely
    const targetBoxStr = String(data.box_barcode || currentLotData?.last_inspection?.box_barcode || "").trim().toUpperCase();
    if (targetBoxStr) {
      let existing = currentInspectedBoxes.find(b => String(b.box_no || "").trim().toUpperCase() === targetBoxStr);
      const nowTime = new Date();
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${pad(nowTime.getDate())}/${pad(nowTime.getMonth() + 1)}/${nowTime.getFullYear()} ${pad(nowTime.getHours())}:${pad(nowTime.getMinutes())}:${pad(nowTime.getSeconds())}`;
      const defaultCam = (document.getElementById("regInspectionNo")?.value || "").trim() || (currentLotData?.inspection_no || "CAM-01");

      if (existing) {
        existing.result = decision;
        existing.time = timeStr;
        existing.operator = `${leaderId} (อนุมัติ: ${decision})`;
      } else {
        currentInspectedBoxes.push({
          cam_no: defaultCam,
          ins_no: currentInspectedBoxes.length + 1,
          box_no: data.box_barcode || targetBoxStr,
          result: decision,
          time: timeStr,
          operator: `${leaderId} (อนุมัติ: ${decision})`
        });
      }
    }

    // Force system state to READY so workstation is ready for next box
    window.lastTrackedSystemState = "READY";
    if (currentLotData) currentLotData.state = "READY";

    // Explicitly guarantee bypass modal is closed
    const bm = document.getElementById("modalBypass");
    if (bm) {
      bm.classList.remove("active");
      bm.style.display = "none";
    }
    // Return to Stage 2 with table updated immediately
    openLotRegScreen(true, true);
  })
  .catch(err => {
    console.error("Leader bypass error:", err);
    window.leaderBypassSubmitted = false;
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
  });
}

function submitLeaderBypass() {
  submitLeaderDecision('G');
}

// ---------------- QVS Clock and Data Helpers ----------------
function updateQvsClocks() {
  const now = new Date();
  const day = now.getDate();
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = monthNames[now.getMonth()];
  const year = now.getFullYear();
  const dateStr = `${day} ${month} ${year}`;
  
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const shortDateStr = `${pad(day)}/${pad(now.getMonth() + 1)}/${year}`;

  const d1 = document.getElementById("qvsDateDisplay1");
  const t1 = document.getElementById("qvsTimeDisplay1");
  const d2 = document.getElementById("qvsDateDisplay2");
  const t2 = document.getElementById("qvsTimeDisplay2");
  const regD = document.getElementById("regLoginDate");
  const regT = document.getElementById("regLoginTime");

  if (d1) d1.textContent = dateStr;
  if (t1) t1.textContent = timeStr;
  if (d2) d2.textContent = dateStr;
  if (t2) t2.textContent = timeStr;
  if (regD && (!regD.dataset.locked)) regD.textContent = shortDateStr;
  if (regT && (!regT.dataset.locked)) regT.textContent = timeStr;
}
setInterval(updateQvsClocks, 1000);

let currentRegBoxes = [];
let opLookupTimeout = null;

function handleOperatorIdChange(opId) {
  clearTimeout(opLookupTimeout);
  opLookupTimeout = setTimeout(() => {
    const cleanId = (opId || "").trim();
    if (!cleanId) return;
    fetch(`/api/operator/lookup?id=${encodeURIComponent(cleanId)}`)
      .then(r => r.json())
      .then(data => {
        if (data && data.operator_name) {
          const nameInput = document.getElementById("preOperatorName");
          if (nameInput) nameInput.value = data.operator_name;
        }
      })
      .catch(() => {});
  }, 250);
}

function clearPreLotInputs() {
  const lotInput = document.getElementById("preLotNumber");
  const opInput = document.getElementById("preOperatorId");
  const nameInput = document.getElementById("preOperatorName");
  if (lotInput) lotInput.value = "";
  if (opInput) opInput.value = "";
  if (nameInput) nameInput.value = "";
  if (lotInput) lotInput.focus();
}

function openPreLotModal(keepInput = false) {
  const modal = document.getElementById("modalPreLotSetup");
  if (modal) {
    updateQvsClocks();
    const savedOpId = sessionStorage.getItem("cira_operator_id") || (currentLotData && currentLotData.operator_id) || "MTL80343";
    const savedOpName = sessionStorage.getItem("cira_operator_name") || (currentLotData && currentLotData.operator_name) || "Aun";
    
    const opInput = document.getElementById("preOperatorId");
    const nameInput = document.getElementById("preOperatorName");
    if (opInput) opInput.value = savedOpId;
    if (nameInput) nameInput.value = savedOpName;

    const preTable = document.getElementById("preTableNo");
    if (preTable) preTable.value = getStationTableNo();
    const joinTable = document.getElementById("joinTableNo");
    if (joinTable) joinTable.value = getStationTableNo();
    switchPreLotMode("new");

    if (savedOpId && (!savedOpName || savedOpName === savedOpId)) {
      handleOperatorIdChange(savedOpId);
    }

    const lotInput = document.getElementById("preLotNumber");
    if (lotInput && !keepInput) {
      // Always fetch fresh next lot number so old finished/abandoned lots never persist on reload!
      fetch("/api/lot/next-number")
        .then(res => res.json())
        .then(d => {
          if (d && d.next_lot_number && lotInput) {
            lotInput.value = d.next_lot_number;
          }
        })
        .catch(() => {
          lotInput.value = getNextLotNumber(currentLotData ? currentLotData.lot_number : null);
        });
    }

    modal.style.display = "flex";
    modal.classList.add("active");
    setTimeout(() => {
      if (lotInput) {
        lotInput.focus();
        lotInput.select();
      }
    }, 150);
  }
}

async function submitPreLotToRegScreen() {
  const lotNumInput = document.getElementById("preLotNumber");
  const lotNum = (lotNumInput?.value || "").trim();
  let opId = (document.getElementById("preOperatorId")?.value || "").trim();
  let opName = (document.getElementById("preOperatorName")?.value || "").trim();

  if (!lotNum) {
    alert("กรุณากรอกหมายเลขล็อตการผลิต (Lot Number)");
    return;
  }
  
  if (!opId) {
    opId = sessionStorage.getItem("cira_operator_id") || "MTL80343";
    const opInput = document.getElementById("preOperatorId");
    if (opInput) opInput.value = opId;
  }
  if (!opName) {
    opName = sessionStorage.getItem("cira_operator_name") || "Sitthichok Suriyawong";
    const opNameInput = document.getElementById("preOperatorName");
    if (opNameInput) opNameInput.value = opName;
  }

  sessionStorage.setItem("cira_operator_id", opId);
  sessionStorage.setItem("cira_operator_name", opName);

  // Check if this lot is paused, closed with pending work, or can be resumed
  let isResumed = false;
  let resumedLot = null;
  try {
    const res = await fetch(`/api/lot/check?lot_number=${encodeURIComponent(lotNum)}`);
    const checkData = await res.json();
    isResumed = Boolean(checkData && (checkData.resumable || checkData.is_resumed));
    resumedLot = (checkData && checkData.lot) ? checkData.lot : checkData;
  } catch (err) {
    console.error("Error checking lot resumable state:", err);
  }

  if (isResumed && resumedLot) {
    const inspCount = resumedLot.inspections_total || (resumedLot.inspections ? resumedLot.inspections.length : 0);
    if (inspCount > 0) {
      const wantResume = confirm(
        `พบล็อต ${lotNum} มีประวัติการตรวจสอบเดิมค้างอยู่ (${inspCount} กล่อง)\n\n• กด [ ตกลง (OK) ] เพื่อตรวจงานต่อจากข้อมูลเดิม (Resume)\n• กด [ ยกเลิก (Cancel) ] เพื่อยกเลิกและเปิดเป็นล็อตใหม่ถัดไป`
      );
      if (!wantResume) {
        // Operator wants a fresh lot! Auto-fill next lot number and stay on setup modal
        fetch("/api/lot/next-number")
          .then(res => res.json())
          .then(d => {
            if (d && d.next_lot_number && lotNumInput) {
              lotNumInput.value = d.next_lot_number;
              lotNumInput.focus();
              lotNumInput.select();
            }
          });
        return;
      }
    }
    closeModal("modalPreLotSetup");
    try {
      openResumedLotScreen(resumedLot, opId, opName);
    } catch (err) {
      console.error("Error rendering resumed lot screen:", err);
      isCurrentInStage2 = true;
      const stage1El = document.getElementById("qvsRightColStage1");
      const stage2El = document.getElementById("qvsRightColStage2");
      if (stage1El) stage1El.style.display = "none";
      if (stage2El) stage2El.style.display = "flex";
      const regModal = document.getElementById("modalLotRegistration");
      if (regModal) {
        regModal.style.display = "flex";
        regModal.classList.add("active");
      }
    }
    return;
  }

  // Close Modal 1
  closeModal("modalPreLotSetup");

  // Populate Screen 2 (modalLotRegistration)
  const regLotNo = document.getElementById("regLotNoDisplay");
  const regOpName = document.getElementById("regOperatorNameDisplay");
  const regOpId = document.getElementById("regOperatorIdDisplay");
  if (regLotNo) regLotNo.textContent = lotNum;
  if (regOpName) regOpName.textContent = opName;
  if (regOpId) regOpId.textContent = opId;

  // Lock login date/time timestamp for this lot registration session
  const regD = document.getElementById("regLoginDate");
  const regT = document.getElementById("regLoginTime");
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  if (regD) {
    regD.textContent = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    regD.dataset.locked = "true";
  }
  if (regT) {
    regT.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    regT.dataset.locked = "true";
  }

  isCurrentInStage2 = false;
  currentInspectedBoxes = [];
  // Clear previous registered boxes table
  currentRegBoxes = [];
  renderRegTable();
  calculateRegBoxes();

  // Carryover is no longer passed to next lot (kept hidden)
  const banner = document.getElementById("qvsCarryoverBanner");
  if (banner) banner.style.display = "none";

  // Open Screen 2 (Default to Stage 1)
  const stage1El = document.getElementById("qvsRightColStage1");
  const stage2El = document.getElementById("qvsRightColStage2");
  if (stage1El) stage1El.style.display = "flex";
  if (stage2El) stage2El.style.display = "none";

  const regModal = document.getElementById("modalLotRegistration");
  if (regModal) {
    regModal.style.display = "flex";
    regModal.classList.add("active");
    setTimeout(() => {
      const scanInput = document.getElementById("regScanBoxInput");
      if (scanInput) {
        scanInput.value = "";
        scanInput.focus();
      }
    }, 200);
  }
}

function calculateRegBoxes() {
  const totalQty = parseInt(document.getElementById("regTotalWorkQty")?.value) || 2000;
  const qtyPerBox = parseInt(document.getElementById("regQtyPerBox")?.value) || 700;

  // Calculate planned boxes automatically: e.g. 2000 / 700 = 2.857 -> Math.ceil = 3 boxes
  const plannedBoxes = Math.max(1, Math.ceil(totalQty / qtyPerBox));
  // Total target boxes is at least plannedBoxes, or more if extra boxes are registered
  const targetBoxes = Math.max(plannedBoxes, currentRegBoxes.length);

  // "จำนวนกล่อง" displays the automatically calculated boxes (e.g. 3)
  const countBox = document.getElementById("regTotalBoxesCount");
  if (countBox) {
    if (currentRegBoxes.length > 0) {
      const isComplete = currentRegBoxes.length >= plannedBoxes;
      const statusColor = isComplete ? "#10b981" : "#94a3b8";
      const statusText = isComplete ? `(สแกนครบ ${currentRegBoxes.length}/${targetBoxes} กล่องแล้ว)` : `(สแกนแล้ว ${currentRegBoxes.length}/${targetBoxes} กล่อง)`;
      countBox.innerHTML = `<span>${targetBoxes}</span> <span style="font-size: 11px; font-weight: 700; color: ${statusColor}; display: block; margin-top: 2px;">${statusText}</span>`;
    } else {
      countBox.textContent = targetBoxes;
    }
  }

  // Highlight Next button when all planned boxes are scanned
  const btnProceed = document.getElementById("btnProceedToInspection");
  if (btnProceed) {
    if (currentRegBoxes.length >= plannedBoxes) {
      btnProceed.className = "qvs-btn-green qvs-btn-next-pulse";
      btnProceed.textContent = "ถัดไป ➔ (สแกนครบแล้ว)";
    } else {
      btnProceed.className = "qvs-btn-green";
      btnProceed.textContent = "ถัดไป ➔";
    }
  }

  const totalCapacity = targetBoxes * qtyPerBox;
  const leftoverQty = (totalCapacity > totalQty) ? (totalCapacity - totalQty) : 0;

  const capEl = document.getElementById("regTotalCapacityText");
  const boxesCalcEl = document.getElementById("regTotalBoxesCalc");
  const leftoverEl = document.getElementById("regLeftoverQtyText");
  if (capEl) capEl.textContent = totalCapacity.toLocaleString();
  if (boxesCalcEl) boxesCalcEl.textContent = targetBoxes;
  if (leftoverEl) leftoverEl.textContent = leftoverQty.toLocaleString();
}

function renderRegTable() {
  const tbody = document.getElementById("lotRegTableBody");
  const thead = document.getElementById("lotRegTableHead");
  const tableTitle = document.getElementById("lotRegTableTitle");
  const btnClear = document.getElementById("btnClearRegBoxes");
  if (!tbody) return;

  if (!isCurrentInStage2) {
    // ==================== STAGE 1: ตารางลงทะเบียนกล่อง (ยังไม่ตรวจจับ) ====================
    if (tableTitle) tableTitle.textContent = "ตารางลงทะเบียนกล่อง";
    if (btnClear) btnClear.style.display = "inline-flex";

    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 12%; text-align: center;">Ins No.</th>
          <th style="width: 36%;">Box No.</th>
          <th style="width: 24%;">เวลาลงทะเบียน</th>
          <th style="width: 20%;">ผู้ลงทะเบียน</th>
          <th style="width: 8%; text-align: center;">ลบ</th>
        </tr>
      `;
    }

    if (currentRegBoxes.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #64748b; padding: 35px 10px;">
            ยังไม่มีกล่องที่ลงทะเบียน กรุณาสแกนบาร์โค้ดกล่องด้านขวาเพื่อเริ่มการลงทะเบียน
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = currentRegBoxes.map((box, idx) => {
      const isCarry = box.is_carryover || box.leftover_qty;
      const boxDisplay = isCarry 
        ? `<span style="font-weight: 700; color: #f59e0b;">${box.box_no}</span> <span style="font-size: 11px; color: #fbbf24; font-weight: 700; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.5); border-radius: 3px; padding: 1px 6px; margin-left: 6px;">(งานเศษเหลือ ${box.leftover_qty} ชิ้น)</span>`
        : `<span style="font-weight: 700; color: #f8fafc;">${box.box_no}</span>`;

      return `
        <tr class="${idx === currentRegBoxes.length - 1 ? 'row-newly-added' : ''}">
          <td style="text-align: center; font-family: var(--font-mono); font-weight: 700; color: #38bdf8;">${box.ins_no}</td>
          <td style="font-family: var(--font-mono);">${boxDisplay}</td>
          <td style="font-family: var(--font-mono); color: #94a3b8;">${box.time}</td>
          <td style="color: #cbd5e1;">${box.operator}</td>
          <td style="text-align: center;">
            <button type="button" class="qvs-btn-del-row" onclick="removeRegBox(${idx})" title="ลบกล่อง ${box.box_no}">✕</button>
          </td>
        </tr>
      `;
    }).join("");

  } else {
    // ==================== STAGE 2: ตารางผลการตรวจสอบกล่องงาน (ตรงตามภาพตัวอย่าง) ====================
    if (tableTitle) tableTitle.textContent = "ตารางผลการตรวจสอบกล่องงาน";
    if (btnClear) btnClear.style.display = "none";

    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width: 16%; text-align: center;">โต๊ะตรวจ</th>
          <th style="width: 28%;">หมายเลขกล่อง</th>
          <th style="width: 12%; text-align: center;">ผลลัพธ์</th>
          <th style="width: 22%;">เวลาที่ตรวจสอบ</th>
          <th style="width: 22%;">ผู้ตรวจสอบ</th>
        </tr>
      `;
    }

    if (currentInspectedBoxes.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #64748b; padding: 35px 10px;">
            ยังไม่มีกล่องที่ได้รับการตรวจสอบ กรุณาสแกนบาร์โค้ดกล่องด้านขวาเพื่อเริ่มการตรวจจับ AI
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = currentInspectedBoxes.map((box, idx) => {
      const isGood = (box.result === "G");
      const isDummy = isDummyInspection(box);
      const resultCell = isGood
        ? `<strong style="font-size: 15px; color: #10b981; font-family: var(--font-mono);">G</strong>`
        : `<strong style="font-size: 15px; color: #ef4444; font-family: var(--font-mono);">NG</strong>`;

      const dummyBadge = isDummy
        ? `<span style="font-size: 11px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid #f59e0b; border-radius: 4px; padding: 1px 6px; margin-left: 6px; font-weight: 600;">(ตัวอย่าง Dummy)</span>`
        : '';

      const tableBadge = `<span class="badge-station-tag">${box.table_no || box.cam_no || getStationTableNo()}</span>`;
      return `
        <tr class="${idx === currentInspectedBoxes.length - 1 ? 'row-newly-added' : ''}" style="${isDummy ? 'background: rgba(245, 158, 11, 0.05);' : ''}">
          <td style="text-align: center;">${tableBadge}</td>
          <td style="font-family: var(--font-mono); font-weight: 700; color: #f8fafc;">${box.box_no}${dummyBadge}</td>
          <td style="text-align: center;">${resultCell}</td>
          <td style="font-family: var(--font-mono); color: #cbd5e1; font-size: 12px;">${box.time}</td>
          <td style="color: #cbd5e1; font-weight: 600;">
            <span>${box.operator_name || box.operator || 'Aun'}</span>
            ${box.operator_id ? `<span style="font-size:10px; color:#94a3b8; display:block;">(${box.operator_id})</span>` : ''}
          </td>
        </tr>
      `;
    }).join("");
  }
}

function removeRegBox(idx) {
  if (idx < 0 || idx >= currentRegBoxes.length) return;
  const removed = currentRegBoxes.splice(idx, 1)[0];
  // Re-index remaining registered boxes
  currentRegBoxes.forEach((b, i) => {
    b.ins_no = i + 1;
  });
  renderRegTable();
  calculateRegBoxes();
  addNotification("ลบรายการกล่อง", `ลบกล่อง ${removed.box_no} ออกจากรายการเรียบร้อย`, "info");
}

function clearAllRegisteredBoxes() {
  if (currentRegBoxes.length === 0) return;
  if (!confirm("ต้องการล้างรายการกล่องทั้งหมดที่สแกนไว้ใช่หรือไม่?")) return;
  currentRegBoxes = [];
  if (currentLotData) {
    currentLotData.registered_boxes = [];
  }
  renderRegTable();
  calculateRegBoxes();
  addNotification("ล้างรายการกล่อง", "ล้างรายการกล่องทั้งหมดเรียบร้อยแล้ว", "info");
}

function resetAllRegData() {
  if (!confirm("ต้องการรีเซ็ตข้อมูลและรายการกล่องทั้งหมดกลับเป็นค่าเริ่มต้นใช่หรือไม่?")) return;
  currentRegBoxes = [];
  if (currentLotData) {
    currentLotData.registered_boxes = [];
  }
  const totalInput = document.getElementById("regTotalWorkQty");
  const perBoxInput = document.getElementById("regQtyPerBox");
  const formatSelect = document.getElementById("regJobFormat");
  const scanInput = document.getElementById("regScanBoxInput");
  const banner = document.getElementById("qvsCarryoverBanner");
  if (totalInput) totalInput.value = "2000";
  if (perBoxInput) perBoxInput.value = "700";
  if (formatSelect) formatSelect.value = "กลาง";
  if (scanInput) scanInput.value = "";
  if (banner) banner.style.display = "none";
  renderRegTable();
  calculateRegBoxes();
  addNotification("รีเซ็ตข้อมูล", "รีเซ็ตข้อมูลสเปกงานและรายการกล่องทั้งหมดกลับเป็นค่าเริ่มต้นเรียบร้อย", "info");
}

async function clearSystemDatabase() {
  if (!confirm("⚠️ คำเตือน: คุณต้องการล้างฐานข้อมูลการผลิตและประวัติทุกล็อต (ทั้งบนเครื่องและ Cloud) เพื่อเริ่มต้นระบบใหม่ทั้งหมดใช่หรือไม่?")) {
    return;
  }
  try {
    const res = await fetch("/api/database/clear-all", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      currentRegBoxes = [];
      currentInspectedBoxes = [];
      currentLotData = null;
      alert("✅ ล้างฐานข้อมูลและประวัติการผลิตทั้งหมดเรียบร้อยแล้ว!\nระบบจะรีเฟรชหน้าจอเพื่อเริ่มต้นใหม่");
      window.location.reload();
    } else {
      alert("เกิดข้อผิดพลาดในการล้างข้อมูล: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อล้างข้อมูลได้: " + err.message);
  }
}
window.clearSystemDatabase = clearSystemDatabase;


// Helper to open Screen 2 (Modal Lot Registration) with Stage 1 or Stage 2 support
function openLotRegScreen(keepExisting = true, isStage2 = false) {
  isCurrentInStage2 = isStage2;
  const regModal = document.getElementById("modalLotRegistration");
  if (!regModal) return;
  regModal.style.display = "flex";

  const regLotNo = document.getElementById("regLotNoDisplay");
  const regOpName = document.getElementById("regOperatorNameDisplay");
  const regOpId = document.getElementById("regOperatorIdDisplay");
  const opName = currentLotData?.operator_name || sessionStorage.getItem("cira_operator_name") || "Sitthichok Suriyawong";
  const opId = currentLotData?.operator_id || sessionStorage.getItem("cira_operator_id") || "MTL80343";
  if (regLotNo && currentLotData?.lot_number) regLotNo.textContent = currentLotData.lot_number;
  if (regOpName) regOpName.textContent = opName;
  if (regOpId) regOpId.textContent = opId;

  // Sync Stage 2 Operator Displays
  const s2OpName = document.getElementById("stage2OpNameDisplay");
  const s2OpId = document.getElementById("stage2OpIdDisplay");
  if (s2OpName) s2OpName.textContent = opName;
  if (s2OpId) s2OpId.textContent = opId;

  if (!keepExisting) {
    currentRegBoxes = [];
  } else if (currentLotData?.registered_boxes && currentLotData.registered_boxes.length > 0) {
    if (currentRegBoxes.length < currentLotData.registered_boxes.length) {
      currentRegBoxes = currentLotData.registered_boxes;
    }
  }
  renderRegTable();
  calculateRegBoxes();

  const stage1El = document.getElementById("qvsRightColStage1");
  const stage2El = document.getElementById("qvsRightColStage2");

  if (isStage2) {
    if (stage1El) stage1El.style.display = "none";
    if (stage2El) stage2El.style.display = "flex";
    updateStage2Stats();
    calculateStage2GoodQty();

    // Check dummy status: if already tested or boxes inspected, keep dummy passed!
    const hasPassedDummy = Boolean(
      currentLotData?.dummy_tested ||
      (currentLotData?.dummy_status?.good_passed && currentLotData?.dummy_status?.ng_passed) ||
      (getRealInspectedBoxes().length > 0)
    );
    if (hasPassedDummy) {
      if (currentLotData) {
        currentLotData.dummy_tested = true;
        currentLotData.dummy_status = { good_passed: true, ng_passed: true };
      }
      updateStage2DummyStatus({ good_passed: true, ng_passed: true }, true);
    } else {
      updateStage2DummyStatus(currentLotData?.dummy_status, currentLotData?.dummy_tested);
    }
    setTimeout(() => {
      const scan2 = document.getElementById("stage2ScanBoxInput");
      const closeBtn = document.getElementById("stage2BtnCloseLot");
      const doneCount = getRealInspectedBoxes().length;
      const targetCount = currentRegBoxes.length;

      if (scan2) {
        if (doneCount < targetCount) {
          const nextBox = currentRegBoxes[doneCount]?.box_no || "";
          scan2.value = nextBox;
          scan2.placeholder = "ยิงบาร์โค้ดกล่อง หรือกด Enter เพื่อตรวจ...";
          scan2.select();
          scan2.focus();
        } else {
          // All boxes completed!
          scan2.value = "";
          scan2.placeholder = "✔ ตรวจครบทุกกล่องแล้ว กรุณากดปุ่มปิดล๊อตด้านล่าง";
        }
      }

      if (closeBtn) {
        if (targetCount > 0 && doneCount >= targetCount) {
          closeBtn.classList.add("qvs-pulse-orange");
          closeBtn.innerHTML = `<span>✔ ตรวจครบ ${doneCount}/${targetCount} กล่อง - คลิกเพื่อปิดล๊อต</span>`;
        } else {
          closeBtn.classList.remove("qvs-pulse-orange");
          closeBtn.innerHTML = `<span>ปิดล๊อต</span>`;
        }
      }
    }, 200);
  } else {
    if (stage1El) stage1El.style.display = "flex";
    if (stage2El) stage2El.style.display = "none";
    setTimeout(() => {
      const scanInput = document.getElementById("regScanBoxInput");
      if (scanInput) {
        scanInput.value = "";
        scanInput.focus();
      }
    }, 200);
  }

  regModal.classList.add("active");
}

function calculateStage2GoodQty() {
  const totalWork = parseInt(document.getElementById("regTotalWorkQty")?.value) || (currentLotData?.total_work_qty || 2000);
  const defectInput = document.getElementById("stage2DefectQty");
  const defectVal = defectInput && defectInput.value !== "" ? parseInt(defectInput.value) || 0 : 0;
  const goodVal = Math.max(0, totalWork - defectVal);

  const goodEl = document.getElementById("stage2GoodQtyDisplay");
  if (goodEl) {
    goodEl.textContent = goodVal.toLocaleString();
  }
}

function updateStage2Stats() {
  const summary = currentLotData?.lot_summary || {};
  const realBoxes = getRealInspectedBoxes();
  const totalInspected = realBoxes.length || summary.inspections_total || 0;
  const qtyPerBox = parseInt(document.getElementById("regQtyPerBox")?.value) || (currentLotData?.qty_per_box || 700);
  const totalWork = parseInt(document.getElementById("regTotalWorkQty")?.value) || (currentLotData?.total_work_qty || 2000);
  let ngBoxes = summary.ng_boxes || 0;
  let defectPieces = summary.defect_qty || 0;

  if (realBoxes.length > 0) {
    const ngCount = realBoxes.filter(b => b.result === "NG").length;
    ngBoxes = ngCount;
    defectPieces = ngBoxes * qtyPerBox;
  }

  const defectEl = document.getElementById("stage2DefectQty");
  const rejectEl = document.getElementById("stage2RejectQty");
  const totalBoxesEl = document.getElementById("stage2TotalBoxes");

  // Keep whatever operator manually typed; do NOT auto-fill defect with defectPieces
  if (defectEl && defectEl.value === "") {
    defectEl.value = "0";
  }
  if (rejectEl) {
    rejectEl.value = ngBoxes;
  }
  if (totalBoxesEl) {
    totalBoxesEl.textContent = totalInspected;
  }

  // Calculate dynamic good pieces: Total Work - Defect
  calculateStage2GoodQty();

  // Leftover note calculation for this lot
  const plannedBoxes = Math.ceil(totalWork / qtyPerBox);
  const totalCapacity = totalInspected * qtyPerBox;
  const leftover = Math.max(0, totalCapacity - totalWork);
  const noticeEl = document.getElementById("stage2LeftoverNotice");
  if (noticeEl) {
    if (totalInspected >= plannedBoxes && leftover > 0) {
      const lastBoxName = (currentRegBoxes && currentRegBoxes[totalInspected - 1]) 
        ? currentRegBoxes[totalInspected - 1].box_no 
        : (realBoxes[totalInspected - 1]?.box_no || "กล่องสุดท้าย");
      noticeEl.style.display = "block";
      noticeEl.innerHTML = `📦 <strong>เศษเหลือในล็อตนี้:</strong> กล่องที่ ${totalInspected} [ <strong>${lastBoxName}</strong> ] มีเศษเหลือ <strong>${leftover} ชิ้น</strong>`;
    } else {
      noticeEl.style.display = "none";
    }
  }

  // Refresh Close button and scan input placeholder based on real inspected boxes
  const scan2 = document.getElementById("stage2ScanBoxInput");
  const closeBtn = document.getElementById("stage2BtnCloseLot");
  const targetCount = currentRegBoxes.length;
  if (closeBtn) {
    if (targetCount > 0 && totalInspected >= targetCount) {
      closeBtn.classList.add("qvs-pulse-orange");
      closeBtn.innerHTML = `<span>✔ ตรวจครบ ${totalInspected}/${targetCount} กล่อง - คลิกเพื่อปิดล๊อต</span>`;
    } else {
      closeBtn.classList.remove("qvs-pulse-orange");
      closeBtn.innerHTML = `<span>ปิดล๊อต</span>`;
    }
  }
  if (scan2 && !scan2.dataset.lockedByDummy) {
    if (targetCount > 0 && totalInspected >= targetCount) {
      scan2.value = "";
      scan2.placeholder = "✔ ตรวจครบทุกกล่องแล้ว กรุณากดปุ่มปิดล๊อตด้านล่าง";
    } else {
      const nextBox = (currentRegBoxes && currentRegBoxes.length > totalInspected) ? currentRegBoxes[totalInspected]?.box_no : String(totalInspected + 1);
      if (!scan2.value || scan2.value === "1" || scan2.value === "2" || scan2.value === "3") {
        scan2.value = nextBox;
      }
      scan2.placeholder = "ยิงบาร์โค้ดกล่อง หรือกด Enter เพื่อตรวจ...";
    }
  }
}

function proceedToStage2() {
  const totalWorkQty = parseInt(document.getElementById("regTotalWorkQty")?.value) || 2000;
  const qtyPerBox = parseInt(document.getElementById("regQtyPerBox")?.value) || 700;
  const plannedBoxes = Math.ceil(totalWorkQty / qtyPerBox);

  if (currentRegBoxes.length < plannedBoxes) {
    if (!confirm(`ระบบคำนวณจำนวนกล่องได้ ${plannedBoxes} กล่อง แต่ปัจจุบันสแกนได้ ${currentRegBoxes.length} กล่อง
ต้องการดำเนินการต่อเพื่อเริ่มตรวจจับหรือไม่?`)) {
      const scanInput = document.getElementById("regScanBoxInput");
      if (scanInput) scanInput.focus();
      return;
    }
  }

  const lotNum = (document.getElementById("regLotNoDisplay")?.textContent || "").trim() || (currentLotData?.lot_number || "LOT-01");
  const opId = (document.getElementById("regOperatorIdDisplay")?.textContent || "").trim() || (currentLotData?.operator_id || "MTL80343");
  const opName = (document.getElementById("regOperatorNameDisplay")?.textContent || "").trim() || (currentLotData?.operator_name || "Sitthichok Suriyawong");
  const partModel = (document.getElementById("regPartName")?.value || "").trim() || "E2E35A222MA387012F+M01/B";
  const targetBoxes = Math.max(currentRegBoxes.length, plannedBoxes, 1);
  const inspectionNo = (document.getElementById("regInspectionNo")?.value || "").trim() || "TEST21200";
  const tableNo = (document.getElementById("regTableNo")?.value || "").trim() || "Offline07";
  const jobFormat = (document.getElementById("regJobFormat")?.value || "").trim() || "กลาง";

  const setupPayload = {
    operator_id: opId,
    operator_name: opName,
    lot_number: lotNum,
    part_model: partModel,
    total_boxes: targetBoxes,
    qty_per_box: qtyPerBox,
    total_work_qty: totalWorkQty,
    inspection_no: inspectionNo,
    table_no: tableNo,
    job_format: jobFormat,
    registered_boxes: currentRegBoxes
  };

  isCurrentInStage2 = true;
  currentInspectedBoxes = [];
  lastCompletedBoxResult = null;
  updateBigDecisionCard({ state: "STANDBY" });
  renderRegTable(); // Immediately clear table and switch to Stage 2 inspection headers

  // Start live collaborative synchronization across stations
  startCollaborativeLotSync(setupPayload.lot_number);

  // Sync lot setup with backend
  fetch("/api/lot/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setupPayload)
  })
  .then(res => res.json())
  .then(() => {
    // Switch right column to Stage 2 (Inspection Pane)
    const stage1El = document.getElementById("qvsRightColStage1");
    const stage2El = document.getElementById("qvsRightColStage2");
    if (stage1El) stage1El.style.display = "none";
    if (stage2El) stage2El.style.display = "flex";

    const s2OpName = document.getElementById("stage2OpNameDisplay");
    const s2OpId = document.getElementById("stage2OpIdDisplay");
    if (s2OpName) s2OpName.textContent = opName;
    if (s2OpId) s2OpId.textContent = opId;

    updateStage2Stats();
    addNotification("เข้าสู่โหมดตรวจจับ", `ลงทะเบียน ${currentRegBoxes.length} กล่องเรียบร้อย ➔ กรุณาสแกนกล่องเพื่อตรวจจับด้วย AI`, "success");

    setTimeout(() => {
      const scan2 = document.getElementById("stage2ScanBoxInput");
      const closeBtn = document.getElementById("stage2BtnCloseLot");
      if (closeBtn) {
        closeBtn.classList.remove("qvs-pulse-orange");
        closeBtn.innerHTML = `<span>ปิดล๊อต</span>`;
      }
      if (scan2) {
        // Auto-fill with the first registered box barcode!
        const firstBox = currentRegBoxes[0]?.box_no || "";
        scan2.value = firstBox;
        scan2.placeholder = "ยิงบาร์โค้ดกล่อง หรือกด Enter เพื่อตรวจ...";
        scan2.select();
        scan2.focus();
      }
    }, 150);
  })
  .catch(err => {
    console.error("Setup error:", err);
    alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลล็อต");
  });
}

function backToStage1() {
  isCurrentInStage2 = false;
  renderRegTable();
  calculateRegBoxes();
  const stage1El = document.getElementById("qvsRightColStage1");
  const stage2El = document.getElementById("qvsRightColStage2");
  if (stage2El) stage2El.style.display = "none";
  if (stage1El) stage1El.style.display = "flex";
  setTimeout(() => {
    const scan1 = document.getElementById("regScanBoxInput");
    if (scan1) scan1.focus();
  }, 150);
}

function handleStage2Scan(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const input = document.getElementById("stage2ScanBoxInput");
  if (!input) return;
  let barcode = input.value.trim();

  // Intercept dummy sample barcodes
  const upperBarcode = barcode.toUpperCase();
  if (upperBarcode.includes("DUMMY-NG") || upperBarcode === "NG" || upperBarcode === "DUMMY_NG") {
    runStage2Dummy("NG_SAMPLE");
    input.value = "";
    return;
  }
  if (upperBarcode.includes("DUMMY-GOOD") || upperBarcode === "GOOD" || upperBarcode === "DUMMY_GOOD") {
    runStage2Dummy("GOOD_SAMPLE");
    input.value = "";
    return;
  }

  // Poka-Yoke Lock: Check if Dummy Test is completed
  const hasPassedDummy = Boolean(
    currentLotData?.dummy_tested ||
    (currentLotData?.dummy_status?.good_passed && currentLotData?.dummy_status?.ng_passed) ||
    (getRealInspectedBoxes().length > 0)
  );
  if (!hasPassedDummy) {
    alert("⛔ Poka-Yoke Lock: บังคับทดสอบชิ้นงานตัวอย่าง (Dummy Test) ให้ผ่านครบก่อน!\n\n1️⃣ กดปุ่ม [ เทสตัวอย่าง NG ] ด้านบนก่อน\n2️⃣ แล้วกดปุ่ม [ เทสตัวอย่าง Good ]\n\nเมื่อทดสอบผ่านครบทั้ง 2 ชิ้นงานแล้ว ระบบจะปลดล็อกให้สแกนกล่องงานจริงได้ทันที");
    return;
  }

  // If input is empty, default to the next uninspected box from currentRegBoxes
  const doneCount = getRealInspectedBoxes().length;
  if (!barcode) {
    if (currentRegBoxes && currentRegBoxes.length > doneCount) {
      barcode = currentRegBoxes[doneCount].box_no;
    }
  }

  if (!barcode) {
    if (currentRegBoxes.length > 0 && doneCount >= currentRegBoxes.length) {
      alert("ตรวจครบทุกกล่องแล้ว กรุณากดปุ่ม [ ปิดล๊อต ] ด้านล่าง");
      return;
    }
    alert("กรุณากรอกหรือสแกนบาร์โค้ดกล่องที่จะตรวจจับ");
    return;
  }

  input.value = "";

  // 1. Cancel any active return-to-stage2 timer immediately!
  if (window.returnIntervalId) {
    clearInterval(window.returnIntervalId);
    window.returnIntervalId = null;
  }
  window.returnToScanTimerRunning = false;
  const camOverlay = document.getElementById("camCountdownOverlay");
  if (camOverlay) {
    camOverlay.style.display = "none";
  }

  // 2. Close modal to reveal camera view immediately!
  closeModal("modalLotRegistration");
  addNotification("เปิดหน้ากล้องตรวจจับ", `สแกนกล่อง: ${barcode} ➔ เปิดหน้ากล้องตรวจจับ G/NG ทันที...`, "info");

  // 3. Trigger camera inspection on backend
  fetch("/api/inspection/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode: barcode })
  })
  .then(res => res.json())
  .then(scanRes => {
    if (scanRes && scanRes.error) {
      alert(scanRes.error);
      openLotRegScreen(true, true);
      return;
    }
    if (scanRes) {
      updateUI(scanRes);
    }
  })
  .catch(err => {
    console.error("Inspection trigger error:", err);
    openLotRegScreen(true, true);
  });
}

function handleRegBoxScan(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const input = document.getElementById("regScanBoxInput");
  if (!input) return;
  const barcode = input.value.trim();
  if (!barcode) return;

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const opName = (document.getElementById("regOperatorNameDisplay")?.textContent || "").trim() || (currentLotData?.operator_name || "Sitthichok Suriyawong");

  // Add box to list if not already present
  let existing = currentRegBoxes.find(b => b.box_no.toUpperCase() === barcode.toUpperCase());
  if (!existing) {
    existing = {
      ins_no: currentRegBoxes.length + 1,
      box_no: barcode,
      time: timeStr,
      operator: opName,
      is_carryover: false,
      leftover_qty: null
    };
    currentRegBoxes.push(existing);
    renderRegTable();
    calculateRegBoxes();
  }

  input.value = "";
  input.focus();

  // Scroll to bottom of table
  const wrapper = document.querySelector(".qvs-table-wrapper");
  if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;

  const totalWorkQty = parseInt(document.getElementById("regTotalWorkQty")?.value) || 2000;
  const qtyPerBox = parseInt(document.getElementById("regQtyPerBox")?.value) || 700;
  const plannedBoxes = Math.ceil(totalWorkQty / qtyPerBox);

  addNotification("ลงทะเบียนกล่อง", `ลงทะเบียนกล่องที่ ${existing.ins_no}: ${barcode} สำเร็จ (รวม ${currentRegBoxes.length}/${plannedBoxes} กล่อง)`, "info");
}

function cancelRegScreen() {
  closeModal("modalLotRegistration");
}

function logoutFromRegScreen() {
  closeModal("modalLotRegistration");
  closeModal("modalPreLotSetup");
  sessionStorage.removeItem("cira_pin_auth");
  const loginScr = document.getElementById("pinLoginScreen");
  if (loginScr) {
    loginScr.classList.remove("logged-in");
    loginScr.style.removeProperty("display");
    loginScr.style.display = "flex";
    loginScr.style.opacity = "1";
    loginScr.style.transform = "none";
  }
}

function confirmLotRegistrationAndStartDummy() {
  const lotNum = (document.getElementById("regLotNoDisplay")?.textContent || "").trim();
  const opId = (document.getElementById("regOperatorIdDisplay")?.textContent || "").trim();
  const opName = (document.getElementById("regOperatorNameDisplay")?.textContent || "").trim();
  const partModel = (document.getElementById("regPartName")?.value || "").trim() || "E2E35A222MA387012F+M01/B";
  const totalWorkQty = parseInt(document.getElementById("regTotalWorkQty")?.value) || 2000;
  const qtyPerBox = parseInt(document.getElementById("regQtyPerBox")?.value) || 700;

  // Standard planned boxes for totalWorkQty (e.g. 2000 / 700 = 3 boxes)
  const plannedBoxes = Math.ceil(totalWorkQty / qtyPerBox);
  const targetBoxes = Math.max(currentRegBoxes.length, plannedBoxes, 1);
  const inspectionNo = (document.getElementById("regInspectionNo")?.value || "").trim() || "TEST21200";
  const tableNo = (document.getElementById("regTableNo")?.value || "").trim() || "Offline07";
  const jobFormat = (document.getElementById("regJobFormat")?.value || "").trim() || "กลาง";

  const payload = {
    operator_id: opId,
    operator_name: opName,
    lot_number: lotNum,
    part_model: partModel,
    total_boxes: targetBoxes,
    qty_per_box: qtyPerBox,
    total_work_qty: totalWorkQty,
    inspection_no: inspectionNo,
    table_no: tableNo,
    job_format: jobFormat,
    registered_boxes: currentRegBoxes
  };

  fetch("/api/lot/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(() => {
    closeModal("modalLotRegistration");
    lastCompletedBoxResult = null;
    updateBigDecisionCard({ state: "READY", total_target_boxes: targetBoxes });

    // 3-second Camera Launch Countdown HUD Overlay (Direct to Camera, No Dummy Test needed)
    window.startupCountdownRunning = true;
    const camCountdownOverlay = document.getElementById("camCountdownOverlay");
    const camCountdownTitleText = document.getElementById("camCountdownTitleText");
    const camCountdownSec = document.getElementById("camCountdownSec");
    const camCountdownBar = document.getElementById("camCountdownBar");
    const camCountdownSubtext = document.getElementById("camCountdownSubtext");

    let startupRemaining = 3.0;
    const totalStartup = 3.0;
    if (camCountdownOverlay) {
      camCountdownOverlay.style.display = "flex";
      camCountdownOverlay.className = "cam-countdown-overlay warn";
    }
    if (camCountdownTitleText) {
      camCountdownTitleText.textContent = "หน่วงเวลา 3 วินาที เพื่อเปิดหน้ากล้องเตรียมตรวจสอบ";
    }
    if (camCountdownSubtext) {
      camCountdownSubtext.textContent = "⚡ ระบบเชื่อมต่อสัญญาณ CiRA CORE โดยตรง ไม่ต้องรอเทสดัมมี่";
    }
    if (camCountdownSec) camCountdownSec.textContent = startupRemaining.toFixed(1);
    if (camCountdownBar) camCountdownBar.style.width = "100%";

    const startupTimer = setInterval(() => {
      startupRemaining = Math.max(0, startupRemaining - 0.1);
      const pct = Math.max(0, Math.min(100, Math.round((startupRemaining / totalStartup) * 100)));
      if (camCountdownSec) camCountdownSec.textContent = startupRemaining.toFixed(1);
      if (camCountdownBar) camCountdownBar.style.width = `${pct}%`;

      if (startupRemaining <= 0.05) {
        clearInterval(startupTimer);
        window.startupCountdownRunning = false;
        if (camCountdownOverlay && (!currentLotData || currentLotData.state === "READY")) {
          camCountdownOverlay.style.display = "none";
        }
        addNotification("เริ่มล็อตสำเร็จ", `ล็อต ${lotNum}: หน้ากล้องพร้อมตรวจสอบ กรุณาสแกนบาร์โค้ดกล่องงาน`, "success");
        const bInput = document.getElementById("barcodeInput");
        if (bInput) bInput.focus();
      }
    }, 100);

    // Explicitly reset on-screen counters and progress to 0 for the new lot
    if (statBoxesDone) statBoxesDone.textContent = "0";
    if (statTargetBoxes) statTargetBoxes.textContent = targetBoxes;
    if (statGoodPieces) statGoodPieces.textContent = "0 ชิ้น";
    if (statDefectPieces) statDefectPieces.textContent = "0 ชิ้น";
    if (statYieldRate) statYieldRate.textContent = "100.0%";
    if (donutProgressCircle) {
      donutProgressCircle.style.strokeDashoffset = "0";
      donutProgressCircle.style.stroke = "#10b981";
    }
    if (progressBoxesText) progressBoxesText.textContent = `0 / ${targetBoxes}`;
    if (progressPctText) progressPctText.textContent = "0%";
    if (lotProgressBar) lotProgressBar.style.width = "0%";
    if (btnDummyGood) {
      btnDummyGood.style.background = "";
      btnDummyGood.style.boxShadow = "";
    }
    if (btnDummyNG) {
      btnDummyNG.style.background = "";
      btnDummyNG.style.boxShadow = "";
    }

    if (headerOperator) headerOperator.textContent = opId;
    if (headerOperatorName) headerOperatorName.textContent = `(${opName})`;
    if (headerLot) headerLot.textContent = lotNum;
    if (headerModel) headerModel.textContent = partModel.split(" ")[0] || partModel;
    if (statTargetBoxes) statTargetBoxes.textContent = targetBoxes;
    initPerBoxChart(targetBoxes);

    const bInput = document.getElementById("barcodeInput");
    if (bInput) bInput.focus();
  })
  .catch(err => {
    console.error(err);
    alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลล็อต");
  });
}


function openResumedLotScreen(lot, opId, opName) {
  // Populate Screen 2 (modalLotRegistration) header & parameters
  const regLotNo = document.getElementById("regLotNoDisplay");
  const regOpName = document.getElementById("regOperatorNameDisplay");
  const regOpId = document.getElementById("regOperatorIdDisplay");
  if (regLotNo) regLotNo.textContent = lot.lot_number || "-";
  if (regOpName) regOpName.textContent = opName || lot.operator_name || "Sitthichok Suriyawong";
  if (regOpId) regOpId.textContent = opId || lot.operator_id || "MTL80343";

  const regTotalWork = document.getElementById("regTotalWorkQty");
  const regQtyBox = document.getElementById("regQtyPerBox");
  const regPart = document.getElementById("regPartName") || document.getElementById("regPartModel");
  const regCam = document.getElementById("regInspectionNo");
  const regTable = document.getElementById("regTableNo");
  const regJob = document.getElementById("regJobFormat");

  if (regTotalWork) regTotalWork.value = lot.total_work_qty || 2000;
  if (regQtyBox) regQtyBox.value = lot.qty_per_box || 700;
  if (regPart) regPart.value = lot.part_name || lot.part_model || "E2E35A222MA387012F+M01/B";
  if (regCam) regCam.value = lot.inspection_no || "TEST21200";
  if (regTable) regTable.value = lot.table_no || "Offline07";
  if (regJob) regJob.value = lot.job_format || "กลาง";

  // Lock login date/time timestamp
  const regD = document.getElementById("regLoginDate");
  const regT = document.getElementById("regLoginTime");
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  if (regD) {
    regD.textContent = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    regD.dataset.locked = "true";
  }
  if (regT) {
    regT.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    regT.dataset.locked = "true";
  }

  // Restore registered boxes from database
  currentRegBoxes = Array.isArray(lot.registered_boxes) ? lot.registered_boxes : [];

  // Restore inspected boxes from database inspections
  currentInspectedBoxes = [];
  const defaultCam = lot.inspection_no || "TEST21200";
  const defaultOp = opName || lot.operator_name || "Sitthichok Suriyawong";
  if (lot.inspections && Array.isArray(lot.inspections)) {
    lot.inspections.forEach((insp, idx) => {
      const bCode = insp.box_barcode || insp.box_id || String(idx + 1);
      if (!bCode) return;
      const res = (insp.final_result || insp.ai_result || "G").toUpperCase();
      currentInspectedBoxes.push({
        cam_no: insp.camera_id || defaultCam,
        table_no: insp.table_no || "Offline07",
        ins_no: insp.box_index || (idx + 1),
        box_no: bCode,
        result: res,
        time: insp.created_at ? formatTime(insp.created_at) : (insp.inspection_time || ""),
        operator: insp.bypassed_by ? `${insp.bypassed_by} (อนุมัติ: ${res})` : (insp.operator_name || insp.operator_id || defaultOp),
        operator_id: insp.operator_id || "",
        operator_name: insp.operator_name || ""
      });
    });
  }

  // Ensure currentRegBoxes has at least the planned boxes
  const targetBoxes = lot.total_target_boxes || Math.max(currentRegBoxes.length, Math.ceil((lot.total_work_qty || 2000) / (lot.qty_per_box || 700)), 3);
  if (currentRegBoxes.length < targetBoxes) {
    for (let i = currentRegBoxes.length + 1; i <= targetBoxes; i++) {
      currentRegBoxes.push({
        ins_no: i,
        box_no: String(i),
        time: "",
        operator: defaultOp
      });
    }
  }

  // Restore currentLotData
  currentLotData = {
    lot_number: lot.lot_number,
    operator_id: opId || lot.operator_id || "MTL80343",
    operator_name: opName || lot.operator_name || "Sitthichok Suriyawong",
    part_model: lot.part_model || "2P",
    part_name: lot.part_name || "E2E35A222MA387012F+M01/B",
    inspection_no: lot.inspection_no || "TEST21200",
    table_no: lot.table_no || "Offline07",
    total_work_qty: lot.total_work_qty || 2000,
    qty_per_box: lot.qty_per_box || 700,
    job_format: lot.job_format || "กลาง",
    total_target_boxes: targetBoxes,
    lot_summary: {
      inspections_total: getRealInspectedBoxes().length,
      good_boxes: getRealInspectedBoxes().filter(b => b.result === "G").length,
      ng_boxes: getRealInspectedBoxes().filter(b => b.result === "NG").length,
      defect_qty: lot.defect_qty_input || 0,
      inspections: lot.inspections || []
    }
  };

  // Switch directly to Stage 2 (ตรงตามรูปภาพตัวอย่างที่ผู้ใช้ส่งมา)
  isCurrentInStage2 = true;
  lastCompletedBoxResult = null;
  updateBigDecisionCard({ state: "STANDBY" });

  const stage1El = document.getElementById("qvsRightColStage1");
  const stage2El = document.getElementById("qvsRightColStage2");
  if (stage1El) stage1El.style.display = "none";
  if (stage2El) stage2El.style.display = "flex";

  const s2OpName = document.getElementById("stage2OpNameDisplay");
  const s2OpId = document.getElementById("stage2OpIdDisplay");
  if (s2OpName) s2OpName.textContent = opName || lot.operator_name || "Sitthichok Suriyawong";
  if (s2OpId) s2OpId.textContent = opId || lot.operator_id || "MTL80343";

  // Restore Stage 2 inputs
  const defectEl = document.getElementById("stage2DefectQty");
  const rejectEl = document.getElementById("stage2RejectQty");
  if (defectEl) defectEl.value = (lot.defect_qty_input !== undefined && lot.defect_qty_input > 0) ? lot.defect_qty_input : "0";
  if (rejectEl) rejectEl.value = (lot.reject_qty_input !== undefined && lot.reject_qty_input > 0) ? lot.reject_qty_input : getRealInspectedBoxes().filter(b => b.result === "NG").length;

  renderRegTable();
  updateStage2Stats();
  calculateStage2GoodQty();

  // If this lot was paused, it needs dummy test again per rule:
  // "การเทสดัมมี่จะเทสเฉพาะ lot ใหม่เข้ามา หรือพนักจบระหว่าง lot เเล้วกลับมาทำต่อ"
  const hasPassed = Boolean(
    lot.dummy_tested || 
    (lot.dummy_status?.good_passed && lot.dummy_status?.ng_passed) || 
    (getRealInspectedBoxes().length > 0)
  );
  if (hasPassed) {
    if (currentLotData) {
      currentLotData.dummy_tested = true;
      currentLotData.dummy_status = { good_passed: true, ng_passed: true };
    }
    updateStage2DummyStatus({ good_passed: true, ng_passed: true }, true);
  } else {
    updateStage2DummyStatus({ good_passed: false, ng_passed: false }, false);
  }

  // Find the next uninspected box from currentRegBoxes
  const doneCount = getRealInspectedBoxes().length;
  let nextBox = "";
  if (currentRegBoxes && currentRegBoxes.length > doneCount) {
    nextBox = currentRegBoxes[doneCount]?.box_no || "";
  }
  if (!nextBox) {
    nextBox = String(doneCount + 1);
  }

  const regModal = document.getElementById("modalLotRegistration");
  if (regModal) {
    regModal.style.display = "flex";
    regModal.classList.add("active");
  }

  setTimeout(() => {
    const scan2 = document.getElementById("stage2ScanBoxInput");
    if (scan2) {
      scan2.value = nextBox;
      scan2.placeholder = "ยิงบาร์โค้ดกล่อง หรือกด Enter เพื่อตรวจ...";
      scan2.select();
      scan2.focus();
    }
    const closeBtn = document.getElementById("stage2BtnCloseLot");
    if (closeBtn) {
      closeBtn.classList.remove("qvs-pulse-orange");
      closeBtn.innerHTML = `<span>ปิดล๊อต</span>`;
    }
  }, 150);

  addNotification("เปิดหน้าตรวจจับทันที", `ล็อต ${lot.lot_number} สแกนไปแล้ว ${doneCount} กล่อง ➔ พร้อมตรวจกล่องที่ ${nextBox} ต่อได้ทันที`, "success");
}

async function confirmPauseLot() {
  const lotNum = currentLotData?.lot_number || (document.getElementById("regLotNoDisplay")?.textContent || "").trim();
  if (!lotNum) {
    alert("ไม่พบข้อมูลล็อตการผลิต");
    return;
  }

  const defectVal = parseInt(document.getElementById("stage2DefectQty")?.value) || 0;
  const rejectVal = parseInt(document.getElementById("stage2RejectQty")?.value) || 0;

  try {
    const res = await fetch("/api/lot/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lot_number: lotNum,
        defect_qty: defectVal,
        reject_qty: rejectVal,
        registered_boxes: currentRegBoxes || []
      })
    });
    const result = await res.json();
    if (!result.success) {
      alert("เกิดข้อผิดพลาดในการบันทึกจบระหว่างล็อต: " + (result.error || ""));
      return;
    }
  } catch (err) {
    console.error("Error pausing lot:", err);
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
    return;
  }

  // Close modals
  closeModal("modalLotClose");
  closeModal("modalLotRegistration");

  // Reset stage 2 flag
  isCurrentInStage2 = false;

  // Open Screen 1 (modalPreLotSetup) and pre-fill the paused lot
  const preLotInput = document.getElementById("preLotNumber");
  if (preLotInput) {
    preLotInput.value = lotNum;
  }

  const modalPre = document.getElementById("modalPreLotSetup");
  if (modalPre) {
    modalPre.style.display = "flex";
    modalPre.classList.add("active");
    setTimeout(() => {
      if (preLotInput) {
        preLotInput.focus();
        preLotInput.select();
      }
    }, 200);
  }

  addNotification("จบระหว่างล็อต (พักงาน)", `บันทึกสถานะล็อต ${lotNum} เรียบร้อยแล้ว เมื่อกลับมาทำงานสามารถสแกนหรือเลือกล็อตเดิมเพื่อตรวจต่อได้ทันที`, "info");
}

function openLotCloseModal() {
  const summary = currentLotData?.lot_summary || {};
  const qty = currentLotData?.qty_per_box || 700;
  const realBoxes = getRealInspectedBoxes();
  let goodBoxes = summary.good_boxes || 0;
  let ngBoxes = summary.ng_boxes || 0;
  let total = realBoxes.length || summary.inspections_total || 0;

  if (realBoxes.length > 0) {
    goodBoxes = realBoxes.filter(b => b.result === "G").length;
    ngBoxes = realBoxes.filter(b => b.result === "NG").length;
    total = realBoxes.length;
  }

  const customDefect = parseInt(document.getElementById("stage2DefectQty")?.value);
  const customReject = parseInt(document.getElementById("stage2RejectQty")?.value);
  if (!isNaN(customReject) && customReject > 0 && ngBoxes === 0) {
    ngBoxes = customReject;
  }

  const target = currentLotData?.total_target_boxes || currentRegBoxes.length || 3;
  const totalWorkTarget = parseInt(document.getElementById("regTotalWorkQty")?.value) || (currentLotData?.total_work_qty || 2000);
  const currentDefect = (!isNaN(customDefect) && customDefect >= 0) ? customDefect : (summary.defect_qty ?? (ngBoxes * qty));
  const currentOutput = Math.max(0, totalWorkTarget - currentDefect);
  const leftoverPieces = Math.max(0, (total * qty) - totalWorkTarget);
  const lastBoxName = (currentRegBoxes && currentRegBoxes.length > 0)
    ? currentRegBoxes[Math.min(total - 1, currentRegBoxes.length - 1)]?.box_no
    : (realBoxes[realBoxes.length - 1]?.box_no || "กล่องสุดท้าย");

  const isComplete = (target > 0 && total >= target);

  let carryoverMsg = "";
  if (leftoverPieces > 0) {
    carryoverMsg = `
      <div style="background: rgba(245, 158, 11, 0.15); border: 1.5px solid #f59e0b; border-radius: 8px; padding: 12px; margin-top: 12px; color: #fbbf24; font-size: 13px; line-height: 1.6;">
        📦 <strong>สรุปงานเศษเหลือในล็อตนี้:</strong><br>
        ล็อตนี้ผลิตครบตามเป้าหมาย <strong>${totalWorkTarget.toLocaleString()} ชิ้น</strong><br>
        จากกล่องที่สแกนตรวจ (${total} กล่อง × ${qty} ชิ้น = ${(total * qty).toLocaleString()} ชิ้น)<br>
        ➔ ทำให้กล่องที่ ${total} [ <strong>${lastBoxName}</strong> ] <strong>มีเศษเหลือ ${leftoverPieces} ชิ้น</strong> (ใช้ไป ${qty - leftoverPieces} ชิ้น)
      </div>
    `;
  }

  let statusBanner = "";
  if (isComplete) {
    statusBanner = `
      <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; border-radius: 6px; padding: 10px; margin-bottom: 12px; color: #34d399; font-weight: 700; display: flex; align-items: center; gap: 8px;">
        <svg style="width: 20px; height: 20px; fill: currentColor; flex-shrink: 0;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
        <span>ตรวจสอบครบตามเป้าหมายของล็อตแล้ว (${currentOutput.toLocaleString()}/${totalWorkTarget.toLocaleString()} ชิ้น - ${total}/${target} กล่อง)</span>
      </div>
      <div style="font-size: 12px; color: #94a3b8; margin-bottom: 12px; line-height: 1.5;">
        ระบบล็อกการตรวจจับไว้ตามข้อกำหนด บังคับกดยืนยันปิดล็อตเพื่อสรุปยอดการผลิต (Traceability) และเริ่มต้นล็อตถัดไป
      </div>
    `;
  } else {
    statusBanner = `
      <div style="background: rgba(234, 179, 8, 0.15); border: 1px solid #eab308; border-radius: 6px; padding: 10px; margin-bottom: 12px; color: #fde047; font-weight: 700; display: flex; align-items: center; gap: 8px;">
        <svg style="width: 20px; height: 20px; fill: currentColor; flex-shrink: 0;" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        <span>ล็อตนี้ยังตรวจไม่ครบ (${total}/${target} กล่อง)</span>
      </div>
      <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 12px; line-height: 1.5;">
        พนักงานสามารถเลือก <strong>"จบระหว่างล็อต"</strong> (เช่น พักกินข้าว) เพื่อบันทึกความคืบหน้าไว้และกลับมาตรวจต่อได้<br>
        หรือเลือก <strong>"จบล็อต"</strong> เพื่อสรุปยอดและปิดล็อตนี้ทันที
      </div>
    `;
  }

  const content = `
    ${statusBanner}
    <div><strong>หมายเลขล็อต:</strong> ${currentLotData?.lot_number || '-'}</div>
    <div><strong>รุ่นชิ้นงาน:</strong> ${currentLotData?.part_model || '-'}</div>
    <div><strong>เป้าหมายการผลิต:</strong> ${totalWorkTarget.toLocaleString()} ชิ้น</div>
    <div><strong>จำนวนกล่องที่ตรวจ:</strong> ${total} / ${target} กล่อง</div>
    <div style="color: #34d399;"><strong>ยอดชิ้นงานดี (Output):</strong> ${currentOutput.toLocaleString()} ชิ้น (${goodBoxes} กล่อง)</div>
    <div style="color: #f87171;"><strong>ยอดชิ้นงานเสีย (Defect):</strong> ${currentDefect.toLocaleString()} ชิ้น (${ngBoxes} กล่อง)</div>
    <div><strong>อัตราของดี (Yield Rate):</strong> ${total > 0 ? ((goodBoxes/total)*100).toFixed(1) : 100}%</div>
    ${carryoverMsg}
  `;
  document.getElementById("lotCloseSummaryContent").innerHTML = content;

  // Toggle button display based on isComplete
  const btnPause = document.getElementById("btnPauseBetweenLot");
  const btnClose = document.getElementById("btnCloseFullLot");
  if (btnPause) {
    btnPause.style.display = isComplete ? "none" : "inline-flex";
  }
  if (btnClose) {
    btnClose.style.display = "inline-flex";
  }

  const closeMod = document.getElementById("modalLotClose");
  if (closeMod) {
    closeMod.style.display = "flex";
    closeMod.classList.add("active");
  }
}

function getNextLotNumber(currentLot) {
  if (!currentLot) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `LOT-${today}-02`;
  }
  const match = currentLot.match(/^(.*?)(\d+)$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10) + 1;
    const padded = String(num).padStart(match[2].length, "0");
    return `${prefix}${padded}`;
  }
  return `${currentLot}-02`;
}

function confirmCloseLot(closeType) {
  if (collaborativeSyncInterval) {
    clearInterval(collaborativeSyncInterval);
    collaborativeSyncInterval = null;
  }
  fetch("/api/lot/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close_type: closeType || "COMPLETED" })
  })
  .then(res => {
    if (!res.ok) throw new Error("HTTP error " + res.status);
    return res.json();
  })
  .then((data) => {
    if (data && data.error) {
      alert("ไม่สามารถปิดล็อตได้: " + data.error);
      return;
    }
    closeModal("modalLotClose");
    closeModal("modalLotRegistration");
    addNotification("ปิดล็อตการผลิตสมบูรณ์", `ล็อต ${currentLotData?.lot_number} ได้รับการปิดและสรุปยอดเรียบร้อยแล้ว`, "info");

    lastCompletedBoxResult = null;
    updateBigDecisionCard({ state: "LOT_CLOSED" });

    // Explicitly reset on-screen counters to 0 immediately
    const target = currentLotData?.total_target_boxes || 3;
    if (statBoxesDone) statBoxesDone.textContent = "0";
    if (statTargetBoxes) statTargetBoxes.textContent = target;
    if (statGoodPieces) statGoodPieces.textContent = "0 ชิ้น";
    if (statDefectPieces) statDefectPieces.textContent = "0 ชิ้น";
    if (statYieldRate) statYieldRate.textContent = "100.0%";
    if (donutProgressCircle) {
      donutProgressCircle.style.strokeDashoffset = "0";
      donutProgressCircle.style.stroke = "#10b981";
    }
    if (progressBoxesText) progressBoxesText.textContent = `0 / ${target}`;
    if (progressPctText) progressPctText.textContent = "0%";
    if (lotProgressBar) lotProgressBar.style.width = "0%";
    initPerBoxChart(target);

    // Auto-generate next lot number
    const oldLot = currentLotData?.lot_number || "LOT-01";
    const nextLot = getNextLotNumber(oldLot);

    const lotInput = document.getElementById("preLotNumber");
    if (lotInput) lotInput.value = nextLot;

    const titleEl = document.getElementById("preLotTitle");
    if (titleEl) {
      titleEl.textContent = "เริ่มต้นล็อตการผลิตใหม่ (New Lot)";
    }

    const descEl = document.getElementById("preLotDesc");
    if (descEl) {
      descEl.innerHTML = `
        <span style="color: #34d399; font-weight: 700;">✔ ปิดล็อตเดิม (${oldLot}) เรียบร้อยแล้ว</span><br>
        กรุณาตรวจสอบหรือระบุ <strong>หมายเลขล็อตใหม่</strong> เพื่อเริ่มการตรวจจับ:
      `;
    }

    openPreLotModal(true);

    setTimeout(() => {
      const input = document.getElementById("preLotNumber");
      if (input) {
        input.focus();
        input.select();
      }
    }, 200);
  })
  .catch(err => {
    console.error(err);
    alert("เกิดข้อผิดพลาดในการปิดล็อต");
  });
}

// ---------------- Traceability Tab (Drill-down Master-Detail) ----------------
let cachedLotsList = [];
let selectedLotNumber = null;
let cachedLotInspections = [];
let previousModalBeforeHistory = null;

let analyticsTimer = null;

function switchTab(tab) {
  document.querySelectorAll(".cyber-tab").forEach(t => t.classList.remove("active"));
  const tabLive = document.getElementById("tabLive");
  const tabAnalytics = document.getElementById("tabAnalytics");
  const tabTrace = document.getElementById("tabTrace");
  const tabSettings = document.getElementById("tabSettings");

  if (tabLive) tabLive.style.display = "none";
  if (tabAnalytics) tabAnalytics.style.display = "none";
  if (tabTrace) tabTrace.style.display = "none";
  if (tabSettings) tabSettings.style.display = "none";

  const tabs = document.querySelectorAll(".cyber-tab");
  if (tab === "live") {
    if (tabs[0]) tabs[0].classList.add("active");
    if (tabLive) tabLive.style.display = "grid";
    stopAnalyticsAutoRefresh();

    if (previousModalBeforeHistory) {
      const prev = previousModalBeforeHistory;
      previousModalBeforeHistory = null;
      if (prev === "STAGE2") {
        openLotRegScreen(true, true);
      } else if (prev === "STAGE1") {
        openLotRegScreen(true, false);
      } else if (prev === "PRE_LOT") {
        openPreLotModal(true);
      }
    }
  } else if (tab === "analytics") {
    if (tabs[1]) tabs[1].classList.add("active");
    if (tabAnalytics) tabAnalytics.style.display = "block";
    loadAnalyticsDashboard(true);
    startAnalyticsAutoRefresh();
  } else if (tab === "trace") {
    const regModal = document.getElementById("modalLotRegistration");
    const preModal = document.getElementById("modalPreLotSetup");
    if (!previousModalBeforeHistory) {
      if (regModal && (regModal.style.display === "flex" || regModal.classList.contains("active"))) {
        previousModalBeforeHistory = isCurrentInStage2 ? "STAGE2" : "STAGE1";
        regModal.style.display = "none";
        regModal.classList.remove("active");
      } else if (preModal && (preModal.style.display === "flex" || preModal.classList.contains("active"))) {
        previousModalBeforeHistory = "PRE_LOT";
        preModal.style.display = "none";
        preModal.classList.remove("active");
      }
    }
    if (tabs[2]) tabs[2].classList.add("active");
    if (tabTrace) tabTrace.style.display = "block";
    stopAnalyticsAutoRefresh();
    showLotsOverview();
  } else if (tab === "settings") {
    if (tabs[3]) tabs[3].classList.add("active");
    if (tabSettings) tabSettings.style.display = "block";
    stopAnalyticsAutoRefresh();
  }
}

function showLotsOverview() {
  selectedLotNumber = null;
  const viewOverview = document.getElementById("viewLotsOverview");
  const viewDetail = document.getElementById("viewLotDetail");
  if (viewOverview) viewOverview.style.display = "block";
  if (viewDetail) viewDetail.style.display = "none";
  loadLotsSummary();
}

function showLotDetail(lotNum) {
  if (!lotNum) return;
  selectedLotNumber = lotNum;

  const viewOverview = document.getElementById("viewLotsOverview");
  const viewDetail = document.getElementById("viewLotDetail");
  if (viewOverview) viewOverview.style.display = "none";
  if (viewDetail) viewDetail.style.display = "block";

  // Fill Header Summary from cachedLotsList or fallback
  const lotObj = cachedLotsList.find(l => l.lot_number === lotNum) || {
    lot_number: lotNum,
    part_model: currentLotData?.part_model || "-",
    operator_id: currentLotData?.operator_id || "-",
    current_boxes_done: currentLotData?.lot_summary?.inspections_total || 0,
    total_target_boxes: currentLotData?.total_target_boxes || 20,
    output_qty: (currentLotData?.lot_summary?.good_boxes || 0) * (currentLotData?.qty_per_box || 50),
    defect_qty: (currentLotData?.lot_summary?.ng_boxes || 0) * (currentLotData?.qty_per_box || 50),
    status: currentLotData?.state || "IN_PROGRESS",
    started_at: "วันนี้",
    closed_at: null
  };

  const detailLotNumber = document.getElementById("detailLotNumber");
  const detailPartModel = document.getElementById("detailPartModel");
  const detailOperator = document.getElementById("detailOperator");
  const detailStatusBadge = document.getElementById("detailStatusBadge");
  const detailBoxesProgress = document.getElementById("detailBoxesProgress");
  const detailGoodOutput = document.getElementById("detailGoodOutput");
  const detailDefectOutput = document.getElementById("detailDefectOutput");
  const detailYieldRate = document.getElementById("detailYieldRate");
  const detailTimestamps = document.getElementById("detailTimestamps");

  if (detailLotNumber) detailLotNumber.textContent = lotObj.lot_number;
  if (detailPartModel) detailPartModel.textContent = lotObj.part_model;
  if (detailOperator) detailOperator.textContent = lotObj.operator_id;

  const isClosed = lotObj.status && lotObj.status.startsWith("CLOSED");
  if (detailStatusBadge) {
    detailStatusBadge.innerHTML = isClosed 
      ? `<span class="badge-pill-status pass">${lotObj.status === 'CLOSED_COMPLETE' ? 'จบล็อตสมบูรณ์' : 'จบระหว่างล็อต'}</span>`
      : `<span class="badge-pill-status" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);">กำลังผลิต</span>`;
  }

  const boxesDone = lotObj.current_boxes_done || 0;
  const targetBoxes = lotObj.total_target_boxes || 20;
  if (detailBoxesProgress) detailBoxesProgress.textContent = `${boxesDone} / ${targetBoxes} กล่อง`;
  if (detailGoodOutput) detailGoodOutput.textContent = `${lotObj.output_qty || 0} ชิ้น`;
  if (detailDefectOutput) detailDefectOutput.textContent = `${lotObj.defect_qty || 0} ชิ้น`;

  if (detailYieldRate) {
    if (boxesDone > 0) {
      const goodBoxes = Math.round((lotObj.output_qty || 0) / (currentLotData?.qty_per_box || 50));
      const yieldPct = ((goodBoxes / boxesDone) * 100).toFixed(1);
      detailYieldRate.textContent = `${yieldPct}%`;
    } else {
      detailYieldRate.textContent = "100.0%";
    }
  }

  if (detailTimestamps) {
    detailTimestamps.textContent = `${lotObj.started_at || '-'} ${lotObj.closed_at ? 'ถึง ' + lotObj.closed_at : '(กำลังดำเนินการ)'}`;
  }

  // Load box inspections for this specific lot
  const tbody = document.getElementById("lotDetailTableBody");
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">กำลังโหลดข้อมูลกล่องของล็อต ${lotNum}...</td></tr>`;
  }

  fetch(`/api/inspections?lot_filter=${encodeURIComponent(lotNum)}`)
    .then(res => res.json())
    .then(data => {
      cachedLotInspections = data || [];
      renderLotDetailTable(cachedLotInspections);

      // Dynamically compute live metrics from actual inspected boxes
      const boxesDone = cachedLotInspections.length;
      const goodBoxes = cachedLotInspections.filter(r => r.final_result === "G").length;
      const ngBoxes = cachedLotInspections.filter(r => r.final_result === "NG").length;
      const targetBoxes = lotObj.total_target_boxes || 3;
      const qtyPerBox = lotObj.qty_per_box || currentLotData?.qty_per_box || 700;
      const totalWorkQty = lotObj.total_work_qty || 2000;

      let totalGoodPieces = (lotObj.output_qty != null) ? lotObj.output_qty : (goodBoxes * qtyPerBox);
      let totalDefectPieces = (lotObj.defect_qty != null) ? lotObj.defect_qty : (ngBoxes * qtyPerBox);

      // Sum from individual inspections if available
      const sumGoodPieces = cachedLotInspections.filter(r => r.final_result === "G").reduce((sum, r) => sum + (r.box_pieces || qtyPerBox), 0);
      if (sumGoodPieces > 0) {
        totalGoodPieces = sumGoodPieces;
      }
      totalGoodPieces = Math.min(totalWorkQty, totalGoodPieces);

      const yieldPct = boxesDone > 0 ? ((goodBoxes / boxesDone) * 100).toFixed(1) : "100.0";

      if (detailBoxesProgress) detailBoxesProgress.textContent = `${boxesDone} / ${targetBoxes} กล่อง`;
      if (detailGoodOutput) detailGoodOutput.textContent = `${totalGoodPieces.toLocaleString()} ชิ้น`;
      if (detailDefectOutput) detailDefectOutput.textContent = `${totalDefectPieces.toLocaleString()} ชิ้น`;
      if (detailYieldRate) detailYieldRate.textContent = `${yieldPct}%`;
    })
    .catch(err => {
      console.error(err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: #f87171; padding: 24px;">เกิดข้อผิดพลาดในการโหลดข้อมูล</td></tr>`;
    });
}

function viewCurrentActiveLot() {
  const currentLot = currentLotData?.lot_number;
  if (currentLot) {
    showLotDetail(currentLot);
  } else {
    alert("ยังไม่มีล็อตที่กำลังผลิตในขณะนี้");
  }
}

function filterLotsList(query) {
  const q = (query || "").toLowerCase().trim();
  const rows = document.querySelectorAll("#lotsTableBody tr");
  rows.forEach(r => {
    const text = r.textContent.toLowerCase();
    r.style.display = text.includes(q) ? "" : "none";
  });
}

function filterBoxTable(query) {
  const q = (query || "").toLowerCase().trim();
  if (!cachedLotInspections) return;
  const filtered = cachedLotInspections.filter(r => 
    (r.box_barcode || "").toLowerCase().includes(q) ||
    (r.final_result || "").toLowerCase().includes(q) ||
    (r.created_at || "").toLowerCase().includes(q)
  );
  renderLotDetailTable(filtered);
}

function openLotHistoryFromModal() {
  const regModal = document.getElementById("modalLotRegistration");
  const preModal = document.getElementById("modalPreLotSetup");

  if (regModal && (regModal.style.display === "flex" || regModal.classList.contains("active"))) {
    previousModalBeforeHistory = isCurrentInStage2 ? "STAGE2" : "STAGE1";
    regModal.style.display = "none";
    regModal.classList.remove("active");
  } else if (preModal && (preModal.style.display === "flex" || preModal.classList.contains("active"))) {
    previousModalBeforeHistory = "PRE_LOT";
    preModal.style.display = "none";
    preModal.classList.remove("active");
  } else {
    previousModalBeforeHistory = null;
  }

  switchTab("trace");
}

function returnFromLotHistory() {
  const prev = previousModalBeforeHistory;
  previousModalBeforeHistory = null;

  switchTab("live");

  if (prev === "STAGE2" || (!prev && currentLotData && currentLotData.lot_number && isCurrentInStage2)) {
    openLotRegScreen(true, true);
  } else if (prev === "STAGE1") {
    openLotRegScreen(true, false);
  } else if (prev === "PRE_LOT") {
    openPreLotModal(true);
  }
}

function resumeLotFromHistory(lotNum) {
  if (!lotNum) return;
  switchTab("live");
  const preInput = document.getElementById("preLotNumber");
  if (preInput) preInput.value = lotNum;
  openPreLotModal(true);
  handlePreLotNumberChange(lotNum);
}

function loadLotsSummary() {
  fetch("/api/lots")
    .then(res => res.json())
    .then(lots => {
      cachedLotsList = lots || [];
      const tbody = document.getElementById("lotsTableBody");
      if (!tbody) return;
      if (!lots || lots.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">ยังไม่มีประวัติการผลิตล็อตใด</td></tr>`;
        return;
      }
      tbody.innerHTML = lots.map(l => {
        const isClosedComplete = (l.status === 'CLOSED_COMPLETE');
        const isPaused = (l.status === 'PAUSED' || l.status === 'CLOSED_PARTIAL');
        const canResume = isPaused || (l.status === 'IN_PROGRESS');
        const statusBadge = isClosedComplete
          ? `<span class="badge-pill-status pass">จบล็อตสมบูรณ์</span>`
          : (isPaused
            ? `<span class="badge-pill-status" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.5);">จบระหว่างล็อต</span>`
            : `<span class="badge-pill-status" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4);">กำลังผลิต</span>`);

        return `
          <tr class="clickable-lot-row" onclick="showLotDetail('${l.lot_number}')" title="คลิกเพื่อดูรายละเอียดกล่องของล็อต ${l.lot_number}">
            <td><strong style="color: #38bdf8; font-family: var(--font-mono); font-size: 13px;">${l.lot_number}</strong></td>
            <td>${l.operator_id || '-'}</td>
            <td>${l.part_model || '-'}</td>
            <td><strong>${l.current_boxes_done || 0}</strong> / ${l.total_target_boxes || 3} กล่อง</td>
            <td style="color: #34d399; font-weight: 700;">${(l.output_qty || 0).toLocaleString()} ชิ้น</td>
            <td style="color: #f87171; font-weight: 700;">${(l.defect_qty || 0).toLocaleString()} ชิ้น</td>
            <td>${statusBadge}</td>
            <td style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${l.started_at || '-'}<br>${l.closed_at ? 'ถึง ' + l.closed_at : '(กำลังผลิต)'}</td>
            <td style="text-align: center;">
              <div style="display: flex; gap: 6px; justify-content: center;">
                <button class="btn-cyan-scan" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); showLotDetail('${l.lot_number}')">
                  🔍 ดูรายละเอียด
                </button>
                ${canResume ? `
                  <button class="btn-cyan-scan" style="padding: 4px 10px; font-size: 11px; background: #059669; border-color: #10b981;" onclick="event.stopPropagation(); resumeLotFromHistory('${l.lot_number}')" title="นำล็อตนี้มาดำเนินการต่อ">
                    ▶ ทำต่อ
                  </button>
                ` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join("");
    })
    .catch(err => console.error(err));
}

function renderLotDetailTable(records) {
  const tbody = document.getElementById("lotDetailTableBody");
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">ไม่พบข้อมูลการตรวจสอบกล่องในล็อตนี้</td></tr>`;
    return;
  }

  tbody.innerHTML = records.map((r, idx) => {
    const isBypass = Boolean(r.is_bypassed);
    const isGood = (r.final_result === "G");
    
    const resultPill = isGood 
      ? `<span class="badge-pill-status pass">G</span>` 
      : `<span class="badge-pill-status fail">NG</span>`;

    const aiResultBadge = (r.ai_result === "G")
      ? `<span style="color: #34d399; font-weight: 700;">G</span>`
      : `<span style="color: #f87171; font-weight: 700;">NG</span>`;

    const bypassCol = isBypass 
      ? `<span style="color: #fbbf24; font-weight: 700; font-family: var(--font-mono);">โดย ${r.bypassed_by || 'LEADER-01'}</span>`
      : `<span style="color: var(--text-dim);">-</span>`;

    const imgPath = r.image_path || "";
    const thumbnailImg = imgPath 
      ? `<img src="${imgPath}" class="trace-thumbnail-img" alt="Evidence" onclick="event.stopPropagation(); previewImage('${imgPath}', '${r.box_barcode}', '${r.final_result}', ${r.confidence_score})" title="คลิกเพื่อขยายดูภาพ">`
      : `<span style="color: var(--text-dim);">-</span>`;

    const imgBtn = imgPath 
      ? `<button class="nav-util-btn" style="padding: 3px 8px; font-size: 11px;" onclick="event.stopPropagation(); previewImage('${imgPath}', '${r.box_barcode}', '${r.final_result}', ${r.confidence_score})">🔍 ดูภาพ</button>`
      : `<span style="color: var(--text-dim);">-</span>`;

    const tableBadge = `<span class="badge-station-tag">${r.table_no || 'Offline07'}</span>`;
    const opNameStr = r.operator_name || r.operator_id || 'Aun';
    return `
      <tr style="cursor: pointer;" onclick="previewImage('${imgPath}', '${r.box_barcode}', '${r.final_result}', ${r.confidence_score})" title="คลิกแถวเพื่อดูภาพขยาย">
        <td style="font-family: var(--font-mono);">${idx + 1}</td>
        <td>${thumbnailImg}</td>
        <td style="font-family: var(--font-mono); font-size: 11px;">${r.created_at}</td>
        <td><code style="font-family: var(--font-mono); color: #38bdf8; font-weight: 700;">${r.box_barcode}</code></td>
        <td>${tableBadge}</td>
        <td><span style="font-weight: 600; color: #f1f5f9;">${opNameStr}</span></td>
        <td>${aiResultBadge}</td>
        <td>${resultPill}</td>
        <td style="font-family: var(--font-mono);">${r.confidence_score.toFixed(1)}%</td>
        <td>${bypassCol}</td>
        <td>${imgBtn}</td>
      </tr>`;
  }).join("");
}

function previewImage(imagePath, barcode = "", result = "G", conf = 99.0) {
  if (!imagePath) {
    alert("ไม่พบไฟล์รูปภาพหลักฐานของกล่องนี้");
    return;
  }
  const modal = document.getElementById("modalImagePreview");
  const img = document.getElementById("previewModalImg");
  const title = document.getElementById("previewTitle");
  if (!modal) return;

  if (img) {
    img.src = imagePath;
  }
  if (title) {
    const isGood = (result === "G");
    const pill = isGood
      ? `<span style="background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-size: 12px; border: 1px solid rgba(16, 185, 129, 0.4);">PASS [G]</span>`
      : `<span style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-size: 12px; border: 1px solid rgba(239, 68, 68, 0.4);">FAIL [NG]</span>`;
    title.innerHTML = `ภาพหลักฐานการตรวจจับ: <strong style="color: #38bdf8; font-family: var(--font-mono);">${barcode || '-'}</strong> | ${pill} <span style="font-size: 12px; color: var(--text-muted); font-family: var(--font-mono);">(AI Confidence: ${Number(conf || 99).toFixed(1)}%)</span>`;
  }
  modal.style.display = "flex";
  modal.classList.add("active");
}

function loadInitialTraceability() {
  loadTraceabilityData(false);
}

function loadTraceabilityData(renderTable = false) {
  fetch("/api/inspections")
    .then(res => res.json())
    .then(data => {
      cachedInspections = data;
      // Update per-box 20-bar chart
      const target = currentLotData?.total_target_boxes || 20;
      updatePerBoxChart(data, target);
    })
    .catch(err => console.error(err));
}

function exportCurrentLotCSV() {
  if (!cachedLotInspections || cachedLotInspections.length === 0) {
    alert("ไม่มีข้อมูลกล่องในล็อตนี้สำหรับส่งออก CSV");
    return;
  }

  const lotName = selectedLotNumber || currentLotData?.lot_number || "LOT";
  const headers = ["ID", "Timestamp", "Lot Number", "Box Barcode", "Operator", "Part Model", "AI Result", "Final Result", "Confidence %", "Bypassed", "Leader ID", "Image File"];
  const rows = cachedLotInspections.map(r => [
    r.id,
    `"${r.created_at}"`,
    `"${r.lot_number}"`,
    `"${r.box_barcode}"`,
    `"${r.operator_id}"`,
    `"${r.part_model}"`,
    `"${r.ai_result}"`,
    `"${r.final_result}"`,
    r.confidence_score,
    r.is_bypassed,
    `"${r.bypassed_by || ''}"`,
    `"${r.image_path || ''}"`
  ]);

  let csvContent = "\uFEFF" + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Traceability_${lotName}_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportCSV() {
  exportCurrentLotCSV();
}

// ---------------- Settings Tab Helpers ----------------
function toggleSimulationMode(val) {
  alert(`โหมดการทำงานถูกตั้งค่าเป็น: ${val === 'true' ? 'จำลองเสมือนจริง' : 'ฮาร์ดแวร์จริง'}`);
}

function testRelayChannels() {
  fetch("/api/modbus/test", { method: "POST" })
    .then(res => res.json())
    .then(() => {
      addNotification("ทดสอบรีเลย์", "ส่งคำสั่งทดสอบรีเลย์ Ch1 -> Ch2 -> Ch3 -> Ch4 เรียบร้อยแล้ว", "info");
      alert("⚡ ส่งสัญญาณทดสอบรีเลย์ครบทั้ง 4 ช่อง (Ch1 -> Ch2 -> Ch3 -> Ch4) เรียบร้อยแล้ว");
    })
    .catch(err => console.error(err));
}

function testSingleChannel(ch) {
  fetch(`/api/modbus/test-channel?channel=${ch}`, { method: "POST" })
    .then(res => res.json())
    .then(() => {
      const names = { 1: "ไฟเขียว Ch1 (Good)", 2: "ไฟแดง Ch2 (NG)", 3: "ไฟเหลือง Ch3 (Standby)", 4: "เสียงเตือน Buzzer Ch4" };
      addNotification("ทดสอบรีเลย์", `ส่งสัญญาณเปิด ${names[ch] || 'Ch ' + ch} เรียบร้อยแล้ว (หน่วง 1.2 วินาที)`, "info");
    })
    .catch(err => console.error("Error testing channel:", err));
}

function saveSettingsForm() {
  addNotification("บันทึกการตั้งค่า", "บันทึกค่าการตั้งค่าฮาร์ดแวร์และพารามิเตอร์ระบบเรียบร้อยแล้ว", "info");
  alert("✅ บันทึกการตั้งค่าระบบและการเชื่อมต่อฮาร์ดแวร์เรียบร้อยแล้ว");
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "";
  }
}

// =============================================================================
// QUALITY ANALYTICS & WEB MONITORING CONTROLLER
// Real-time G/NG Metrics, Pareto Defect Breakdown & Live Incident Feed
// =============================================================================

let cachedAnalyticsSummary = null;
let cachedParetoData = null;

async function loadAnalyticsDashboard(force = false) {
  try {
    const [summaryRes, paretoRes, lotsRes, defectsRes] = await Promise.all([
      fetch("/api/analytics/summary"),
      fetch("/api/analytics/pareto"),
      fetch("/api/analytics/lots-comparison?limit=10"),
      fetch("/api/analytics/recent-defects?limit=8")
    ]);

    const summary = await summaryRes.json();
    const pareto = await paretoRes.json();
    const lots = await lotsRes.json();
    const defects = await defectsRes.json();

    cachedAnalyticsSummary = summary;
    cachedParetoData = pareto;

    // 1. Update Top KPI Cards
    const anaTotalBoxes = document.getElementById("anaTotalBoxes");
    if (anaTotalBoxes) anaTotalBoxes.textContent = `${summary.total_boxes.toLocaleString()} กล่อง`;

    const anaGoodPieces = document.getElementById("anaGoodPieces");
    if (anaGoodPieces) anaGoodPieces.textContent = `${summary.total_good_pieces.toLocaleString()} ชิ้น`;

    const anaGoodBoxesSub = document.getElementById("anaGoodBoxesSub");
    if (anaGoodBoxesSub) anaGoodBoxesSub.textContent = `(${summary.good_boxes.toLocaleString()} กล่อง)`;

    const anaDefectPieces = document.getElementById("anaDefectPieces");
    if (anaDefectPieces) anaDefectPieces.textContent = `${summary.total_defect_pieces.toLocaleString()} ชิ้น`;

    const anaDefectBoxesSub = document.getElementById("anaDefectBoxesSub");
    if (anaDefectBoxesSub) anaDefectBoxesSub.textContent = `(${summary.ng_boxes.toLocaleString()} กล่อง)`;

    const anaYieldRate = document.getElementById("anaYieldRate");
    if (anaYieldRate) {
      anaYieldRate.textContent = `${summary.yield_rate.toFixed(1)}%`;
      if (summary.yield_rate >= 98.0) {
        anaYieldRate.style.color = "#34d399"; // Green
      } else if (summary.yield_rate >= 95.0) {
        anaYieldRate.style.color = "#fbbf24"; // Yellow
      } else {
        anaYieldRate.style.color = "#f87171"; // Red
      }
    }

    const anaAvgCycleTime = document.getElementById("anaAvgCycleTime");
    if (anaAvgCycleTime) anaAvgCycleTime.textContent = `${summary.avg_cycle_time_ms.toLocaleString()} ms`;

    // 2. Update Quality Breakdown Progress Bars
    const goodPct = summary.yield_rate;
    const ngPct = summary.defect_rate;
    const bypassPct = summary.total_boxes > 0 ? ((summary.bypassed_boxes / summary.total_boxes) * 100).toFixed(1) : 0.0;

    const anaDistGoodPct = document.getElementById("anaDistGoodPct");
    if (anaDistGoodPct) anaDistGoodPct.textContent = `${goodPct.toFixed(1)}% (${summary.good_boxes} กล่อง)`;
    const anaDistGoodBar = document.getElementById("anaDistGoodBar");
    if (anaDistGoodBar) anaDistGoodBar.style.width = `${goodPct}%`;

    const anaDistNgPct = document.getElementById("anaDistNgPct");
    if (anaDistNgPct) anaDistNgPct.textContent = `${ngPct.toFixed(1)}% (${summary.ng_boxes} กล่อง)`;
    const anaDistNgBar = document.getElementById("anaDistNgBar");
    if (anaDistNgBar) anaDistNgBar.style.width = `${ngPct}%`;

    const anaDistBypassPct = document.getElementById("anaDistBypassPct");
    if (anaDistBypassPct) anaDistBypassPct.textContent = `${bypassPct}% (${summary.bypassed_boxes} กล่อง)`;
    const anaDistBypassBar = document.getElementById("anaDistBypassBar");
    if (anaDistBypassBar) anaDistBypassBar.style.width = `${bypassPct}%`;

    const anaConfidenceAvg = document.getElementById("anaConfidenceAvg");
    if (anaConfidenceAvg) anaConfidenceAvg.textContent = `${summary.avg_confidence}%`;

    // 3. Render Pareto Defect Chart
    renderParetoChart(pareto);

    // 4. Render Lots Comparison Table
    renderLotsComparisonTable(lots);

    // 5. Render Recent Defect Feed
    renderRecentDefectsFeed(defects);

  } catch (err) {
    console.error("Error loading analytics dashboard:", err);
  }
}

function renderParetoChart(paretoData) {
  const container = document.getElementById("anaParetoContainer");
  if (!container) return;

  if (!paretoData || paretoData.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 18px;">ยังไม่พบประวัติงานเสียในระบบ (100% Quality)</div>`;
    return;
  }

  const totalDefects = paretoData.reduce((acc, cur) => acc + cur.count, 0);
  const totalBadge = document.getElementById("anaParetoTotalDefects");
  if (totalBadge) totalBadge.textContent = `งานเสียสะสม ${totalDefects} กล่อง`;

  if (paretoData.length >= 2) {
    const top2Cumulative = paretoData[1].cumulative_percentage;
    const top2El = document.getElementById("anaParetoTop2Pct");
    if (top2El) top2El.textContent = `2 อันดับแรกคิดเป็น ${top2Cumulative}% ของงานเสียทั้งหมด`;
  }

  let html = "";
  paretoData.forEach((item, index) => {
    // Determine bar color by rank
    const color = index === 0 ? "#ef4444" : index === 1 ? "#f97316" : index === 2 ? "#eab308" : "#38bdf8";
    html += `
      <div style="background: rgba(255, 255, 255, 0.02); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 5px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: ${color}22; color: ${color}; font-size: 10px; font-weight: 800;">
              ${index + 1}
            </span>
            <span style="font-weight: 600; color: var(--text-primary);">${item.label_th}</span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 11px;">
            <strong style="color: ${color};">${item.count} ครั้ง</strong> 
            <span style="color: var(--text-muted);">(${item.percentage}%)</span> 
            <span style="color: var(--text-muted); margin-left: 4px;">| สะสม: <strong>${item.cumulative_percentage}%</strong></span>
          </div>
        </div>
        <div style="position: relative; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden;">
          <div style="height: 100%; width: ${item.percentage}%; background: ${color}; border-radius: 4px; transition: width 0.4s ease;"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function renderLotsComparisonTable(lots) {
  const tbody = document.getElementById("anaLotsTableBody");
  if (!tbody) return;

  if (!lots || lots.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 18px;">ไม่พบข้อมูลล็อตการผลิต</td></tr>`;
    return;
  }

  tbody.innerHTML = lots.map(l => {
    const yieldColor = l.yield_rate >= 98.0 ? "#34d399" : l.yield_rate >= 95.0 ? "#fbbf24" : "#f87171";
    const statusBg = l.status.startsWith("CLOSED") ? "rgba(52, 211, 153, 0.15)" : "rgba(56, 189, 248, 0.15)";
    const statusColor = l.status.startsWith("CLOSED") ? "#34d399" : "#38bdf8";
    const statusText = l.status === "CLOSED_COMPLETE" ? "จบล็อตปกติ" : l.status === "CLOSED_PARTIAL" ? "จบก่อนกำหนด" : "กำลังผลิต";

    return `
      <tr>
        <td>
          <a href="javascript:void(0)" onclick="switchTab('trace'); showLotDetail('${l.lot_number}')" style="color: #38bdf8; text-decoration: none; font-weight: 700; font-family: var(--font-mono);">
            ${l.lot_number}
          </a>
        </td>
        <td>${l.part_model.split(" ")[0]}</td>
        <td><strong>${l.current_boxes_done}</strong> / ${l.total_target_boxes}</td>
        <td>
          <span style="color: #34d399;">${l.good_boxes}</span> / 
          <span style="color: #f87171;">${l.ng_boxes}</span>
        </td>
        <td>
          <span style="color: ${yieldColor}; font-weight: 700; font-family: var(--font-mono);">${l.yield_rate.toFixed(1)}%</span>
        </td>
        <td>
          <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: ${statusBg}; color: ${statusColor};">
            ${statusText}
          </span>
        </td>
      </tr>
    `;
  }).join("");
}

function renderRecentDefectsFeed(defects) {
  const container = document.getElementById("anaRecentDefectsContainer");
  if (!container) return;

  if (!defects || defects.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #34d399; padding: 20px;">✔ ไม่พบรายการงานเสียในประวัติล่าสุด (Line Quality 100%)</div>`;
    return;
  }

  const defectLabels = {
    "TAPE_COVERED": "มีเทปปิดทับขอบ",
    "INVERTED": "ใส่กลับทิศทาง",
    "MISSING": "ชิ้นงานหาย/ไม่ครบ",
    "MISALIGNED": "ชิ้นงานเอียง"
  };

  container.innerHTML = defects.map(d => {
    const dType = d.defect_type || "TAPE_COVERED";
    const label = defectLabels[dType] || dType;
    const isBypassed = d.is_bypassed === 1;
    const imgThumb = d.image_path || "/static/images/no-image.png";

    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--bg-card-sub); border: 1px solid var(--border-subtle); border-radius: 6px; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <!-- Thumbnail preview with lightbox click -->
          <div style="position: relative; width: 44px; height: 34px; border-radius: 4px; overflow: hidden; border: 1px solid var(--border-strong); cursor: pointer; flex-shrink: 0;"
               onclick="previewImage('${d.image_path}', '${d.box_barcode}', '${d.final_result}', ${d.confidence_score})">
            <img src="${imgThumb}" alt="Defect" style="width: 100%; height: 100%; object-fit: cover;">
            <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;">
              <svg style="width: 12px; height: 12px; fill: #ffffff;" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </div>
          </div>

          <div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-primary);">${d.box_barcode}</span>
              <span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 700; background: rgba(239, 68, 68, 0.15); color: #f87171;">
                ${label}
              </span>
              ${isBypassed ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 700; background: rgba(251, 191, 36, 0.15); color: #fbbf24;">Bypass</span>' : ''}
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
              <span>ล็อต: ${d.lot_number}</span> &bull; 
              <span>${d.created_at.slice(11, 19)}</span> &bull; 
              <span>AI Conf: ${(d.confidence_score || 99).toFixed(1)}%</span>
            </div>
          </div>
        </div>

        <button class="nav-util-btn" style="padding: 4px 8px; font-size: 11px;"
                onclick="previewImage('${d.image_path}', '${d.box_barcode}', '${d.final_result}', ${d.confidence_score})">
          ดูรูปภาพ
        </button>
      </div>
    `;
  }).join("");
}

function toggleAnalyticsAutoRefresh(enabled) {
  if (enabled) {
    startAnalyticsAutoRefresh();
  } else {
    stopAnalyticsAutoRefresh();
  }
}

function startAnalyticsAutoRefresh() {
  stopAnalyticsAutoRefresh();
  const checkbox = document.getElementById("analyticsAutoRefresh");
  if (checkbox && checkbox.checked) {
    analyticsTimer = setInterval(() => {
      const tabAnalytics = document.getElementById("tabAnalytics");
      if (tabAnalytics && tabAnalytics.style.display !== "none") {
        loadAnalyticsDashboard(false);
      }
    }, 5000);
  }
}

function stopAnalyticsAutoRefresh() {
  if (analyticsTimer) {
    clearInterval(analyticsTimer);
    analyticsTimer = null;
  }
}

function exportAnalyticsReportCSV() {
  if (!cachedAnalyticsSummary) {
    alert("กรุณารอข้อมูลสถิติโหลดเสร็จสิ้นก่อนส่งออก");
    return;
  }

  const s = cachedAnalyticsSummary;
  let csv = "\uFEFF";
  csv += "=== MURATA ELECTRONICS DX12 QUALITY MONITORING REPORT ===\n";
  csv += `Date Generated,${new Date().toISOString()}\n`;
  csv += `Total Boxes Inspected,${s.total_boxes}\n`;
  csv += `Total Good Pieces,${s.total_good_pieces}\n`;
  csv += `Total Defect Pieces,${s.total_defect_pieces}\n`;
  csv += `Overall Yield Rate,${s.yield_rate}%\n`;
  csv += `Overall Defect Rate,${s.defect_rate}%\n`;
  csv += `Average Cycle Time,${s.avg_cycle_time_ms} ms\n\n`;

  csv += "=== PARETO DEFECT BREAKDOWN ===\n";
  csv += "Defect Type,Thai Label,Count,Percentage,Cumulative Percentage\n";
  if (cachedParetoData) {
    cachedParetoData.forEach(p => {
      csv += `"${p.defect_type}","${p.label_th}",${p.count},${p.percentage}%,${p.cumulative_percentage}%\n`;
    });
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Quality_Analytics_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

let preLotScanDebounce = null;
function handlePreLotNumberChange(val) {
  val = (val || "").trim();
  if (!val) return;
  if (preLotScanDebounce) clearTimeout(preLotScanDebounce);
  preLotScanDebounce = setTimeout(() => {
    if (val.length >= 3) {
      submitPreLotToRegScreen();
    }
  }, 350);
}


function updateStage2DummyStatus(dummyStatus, dummyTested) {
  const card = document.getElementById("stage2DummyCard");
  const badge = document.getElementById("stage2DummyBadge");
  const hint = document.getElementById("stage2DummyHint");
  const btnNG = document.getElementById("btnStage2DummyNG");
  const btnGood = document.getElementById("btnStage2DummyGood");
  const scanInput = document.getElementById("stage2ScanBoxInput");

  const ngPassed = Boolean(dummyStatus && dummyStatus.ng_passed);
  const goodPassed = Boolean(dummyStatus && dummyStatus.good_passed);
  const isDone = Boolean(dummyTested || (ngPassed && goodPassed));

  if (!card) return;

  if (isDone) {
    // Both NG and Good passed!
    card.style.borderColor = "#10b981";
    card.style.background = "rgba(16, 185, 129, 0.08)";
    if (badge) {
      badge.textContent = "✅ ผ่านครบถ้วน (PASS)";
      badge.style.background = "#10b981";
    }
    if (hint) {
      hint.innerHTML = "<span style='color: #34d399; font-weight: 700;'>✅ ทดสอบตัวอย่างผ่านครบแล้ว พร้อมสแกนตรวจกล่องงานจริงได้ทันที</span>";
    }
    if (btnNG) {
      btnNG.innerHTML = "✅ NG ผ่าน";
      btnNG.style.background = "#059669";
      btnNG.style.borderColor = "#10b981";
      btnNG.disabled = true;
      btnNG.style.cursor = "default";
      btnNG.style.boxShadow = "none";
    }
    if (btnGood) {
      btnGood.innerHTML = "✅ Good ผ่าน";
      btnGood.style.background = "#059669";
      btnGood.style.borderColor = "#10b981";
      btnGood.disabled = true;
      btnGood.style.cursor = "default";
      btnGood.style.boxShadow = "none";
    }
    if (scanInput && scanInput.dataset.lockedByDummy === "true") {
      delete scanInput.dataset.lockedByDummy;
      scanInput.style.borderColor = "";
      scanInput.style.background = "";
      scanInput.placeholder = "ยิงบาร์โค้ดกล่อง หรือกด Enter เพื่อตรวจ...";
      // Pre-fill next box
      const doneCount = getRealInspectedBoxes().length;
      let nextBox = (currentRegBoxes && currentRegBoxes.length > doneCount) ? currentRegBoxes[doneCount]?.box_no : String(doneCount + 1);
      if (!scanInput.value) scanInput.value = nextBox;
      scanInput.focus();
      scanInput.select();
    }
  } else {
    // Still pending dummy test!
    card.style.borderColor = "#f59e0b";
    card.style.background = "rgba(245, 158, 11, 0.08)";
    if (badge) {
      badge.textContent = "รอดำเนินการ";
      badge.style.background = "#ef4444";
    }

    if (ngPassed) {
      // Step 1 (NG) passed! Step 2 (Good) is now ACTIVE!
      if (btnNG) {
        btnNG.innerHTML = "✅ 1. NG ผ่าน";
        btnNG.style.background = "#059669";
        btnNG.style.borderColor = "#10b981";
        btnNG.disabled = true;
        btnNG.style.cursor = "default";
        btnNG.style.boxShadow = "none";
      }
      if (btnGood) {
        btnGood.innerHTML = "2️⃣ เทสตัวอย่าง Good";
        btnGood.style.background = "#10b981";
        btnGood.style.color = "#ffffff";
        btnGood.style.borderColor = "#059669";
        btnGood.disabled = false;
        btnGood.style.cursor = "pointer";
        btnGood.style.boxShadow = "0 0 10px rgba(16, 185, 129, 0.5)";
      }
      if (hint) {
        hint.innerHTML = "<span style='color: #fbbf24; font-weight: 700;'>✅ NG ผ่านแล้ว ➔ กรุณากดเทสตัวอย่าง Good เพื่อปลดล็อกระบบ</span>";
      }
    } else {
      // Step 1 (NG) not yet passed! Must test NG FIRST!
      if (btnNG) {
        btnNG.innerHTML = "1️⃣ เทสตัวอย่าง NG";
        btnNG.style.background = "#ef4444";
        btnNG.style.color = "#ffffff";
        btnNG.style.borderColor = "#dc2626";
        btnNG.disabled = false;
        btnNG.style.cursor = "pointer";
        btnNG.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.5)";
      }
      if (btnGood) {
        btnGood.innerHTML = "2️⃣ เทสตัวอย่าง Good";
        btnGood.style.background = "#334155";
        btnGood.style.color = "#64748b";
        btnGood.style.borderColor = "#475569";
        btnGood.disabled = true;
        btnGood.style.cursor = "not-allowed";
        btnGood.style.boxShadow = "none";
      }
      if (hint) {
        hint.innerHTML = "⚠️ บังคับทดสอบตัวอย่าง <strong>NG ก่อน</strong> แล้วตามด้วย <strong>Good</strong> ก่อนสแกนกล่อง";
      }
    }

    // Lock scan input until dummy test passes
    if (scanInput) {
      scanInput.dataset.lockedByDummy = "true";
      scanInput.placeholder = "⚠️ บังคับเทส Dummy ให้ผ่านก่อนสแกนกล่อง!";
    }
  }
}

async function runStage2Dummy(sampleType) {
  try {
    const res = await fetch("/api/dummy/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample_type: sampleType })
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }

    const isGood = (sampleType === "GOOD_SAMPLE");
    const label = isGood ? "Good (G)" : "Defect (NG)";
    addNotification("ทดสอบ Dummy Test", `ทดสอบตัวอย่าง ${label} เรียบร้อย ➔ ผลลัพธ์: PASS`, "info");

    if (currentLotData) {
      if (!currentLotData.dummy_status) currentLotData.dummy_status = {};
      if (isGood) currentLotData.dummy_status.good_passed = true;
      else currentLotData.dummy_status.ng_passed = true;
      currentLotData.dummy_tested = Boolean(currentLotData.dummy_status.good_passed && currentLotData.dummy_status.ng_passed);
      updateStage2DummyStatus(currentLotData.dummy_status, currentLotData.dummy_tested);
      
      renderRegTable();
      updateStage2Stats();

      if (currentLotData.dummy_tested) {
        alert("✅ ทดสอบ Dummy Test ผ่านครบถ้วน (ทั้ง NG และ Good) เรียบร้อยแล้ว!\n\nระบบปลดล็อกให้สแกนกล่องงานจริงได้ทันที");
      }
    }
  } catch (err) {
    console.error("Error running dummy test:", err);
    alert("เกิดข้อผิดพลาดในการทดสอบ Dummy Test");
  }
}


// ======================================================================
// Supabase Cloud Integration & Legacy 16-Columns History View
// ======================================================================

let cachedLegacyHistory = [];

async function checkSupabaseStatusManual() {
  const pill = document.getElementById("supabaseCloudPill");
  const dot = document.getElementById("supabasePillDot");
  const text = document.getElementById("supabasePillText");

  try {
    const res = await fetch("/api/supabase/status");
    const data = await res.json();
    if (data.online) {
      if (pill) {
        pill.style.borderColor = "#10b981";
        pill.style.background = "rgba(16, 185, 129, 0.15)";
        pill.style.color = "#10b981";
      }
      if (dot) {
        dot.style.background = "#10b981";
        dot.style.boxShadow = "0 0 6px #10b981";
      }
      if (text) text.textContent = "☁️ Supabase: Online";
      addNotification("Supabase Cloud", `เชื่อมต่อฐานข้อมูล Supabase สำเร็จ (Bucket: ${data.bucket || 'inspection-evidence'})`, "success");
    } else {
      if (pill) {
        pill.style.borderColor = "#f59e0b";
        pill.style.background = "rgba(245, 158, 11, 0.15)";
        pill.style.color = "#f59e0b";
      }
      if (dot) {
        dot.style.background = "#f59e0b";
        dot.style.boxShadow = "0 0 6px #f59e0b";
      }
      if (text) text.textContent = "☁️ Supabase: Offline (Local Mode)";
      addNotification("Supabase Cloud", "ไม่สามารถเชื่อมต่อ Supabase ได้ (ระบบกำลังทำงานด้วย Local SQLite อัตโนมัติ)", "warning");
    }
  } catch (err) {
    console.error("Supabase check error:", err);
  }
}

async function triggerManualSupabaseSync() {
  addNotification("Supabase Cloud", "กำลังซิงค์ข้อมูลทั้งหมดขึ้น Supabase Cloud...", "info");
  try {
    const res = await fetch("/api/supabase/sync-all", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      addNotification(
        "ซิงค์ข้อมูลสำเร็จ",
        `อัปโหลดไปยัง Supabase แล้ว: ${data.synced_lots} ล็อต, ${data.synced_inspections} กล่อง`,
        "success"
      );
      // If modal is open, reload it
      const modal = document.getElementById("modalLegacyHistory");
      if (modal && modal.style.display !== "none") {
        loadLegacyHistoryFromSupabase();
      }
    } else {
      alert("เกิดข้อผิดพลาดในการซิงค์ข้อมูล: " + (data.error || ""));
    }
  } catch (err) {
    console.error("Sync error:", err);
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อ Supabase");
  }
}

function openLegacyHistoryModal() {
  const modal = document.getElementById("modalLegacyHistory");
  if (modal) {
    modal.style.display = "flex";
    modal.classList.add("active");
  }
  loadLegacyHistoryFromSupabase();
}

async function loadLegacyHistoryFromSupabase() {
  const tbody = document.getElementById("legacyHistoryTableBody");
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="16" style="text-align: center; color: var(--text-muted); padding: 24px;">กำลังดึงข้อมูล 16 คอลัมน์จาก Supabase Cloud...</td></tr>';
  }

  try {
    const res = await fetch("/api/supabase/legacy-history?limit=250");
    const list = await res.json();
    cachedLegacyHistory = Array.isArray(list) ? list : [];

    if (!tbody) return;
    if (cachedLegacyHistory.length === 0) {
      tbody.innerHTML = '<tr><td colspan="16" style="text-align: center; color: var(--text-muted); padding: 24px;">ยังไม่มีข้อมูลประวัติบน Supabase (กรุณากดปุ่ม "ซิงค์ขึ้น Cloud")</td></tr>';
      return;
    }

    tbody.innerHTML = cachedLegacyHistory.map(row => {
      const isGood = (row.CheckResult === "G");
      const resBadge = isGood
        ? '<span class="badge-pill-status pass" style="padding: 2px 8px; font-weight: 800;">G</span>'
        : '<span class="badge-pill-status fail" style="padding: 2px 8px; font-weight: 800;">NG</span>';

      const isFinish = (row.Status === "Finish");
      const statusBadge = isFinish
        ? '<span style="color: #34d399; font-weight: 700;">Finish</span>'
        : (row.Status === "Pause" ? '<span style="color: #fbbf24; font-weight: 700;">Pause</span>' : '<span style="color: #38bdf8; font-weight: 700;">In Progress</span>');

      return `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="font-weight: 700; color: #38bdf8;">${row.InsNo || '-'}</td>
          <td style="font-weight: 700;">${row.LotNo || '-'}</td>
          <td style="font-weight: 800; color: ${row.BoxNo === 'SENSOR' ? '#fbbf24' : 'var(--text-primary)'};">${row.BoxNo || '-'}</td>
          <td>${row.TableNo || '-'}</td>
          <td style="text-align: center;">${resBadge}</td>
          <td style="font-family: var(--font-mono); font-size: 11px;">${row.CheckTime || '-'}</td>
          <td style="font-weight: 600;">${row.Checker || '-'}</td>
          <td style="font-family: var(--font-mono); font-size: 11px;">${row.StartTime || '-'}</td>
          <td style="font-family: var(--font-mono); font-size: 11px;">${row.FinishTime || '-'}</td>
          <td><span class="badge-pill-status" style="background: rgba(148, 163, 184, 0.1); font-size: 10px;">${row.Worktype || '-'}</span></td>
          <td style="text-align: right; font-weight: 600;">${(row.InputTotal || 0).toLocaleString()}</td>
          <td style="text-align: right; font-weight: 600; color: #34d399;">${(row.OutputTotal || 0).toLocaleString()}</td>
          <td style="text-align: right; font-weight: 600; color: ${row.Defect > 0 ? '#f87171' : 'var(--text-muted)'};">${(row.Defect || 0).toLocaleString()}</td>
          <td style="text-align: right; font-weight: 600;">${(row.Reject || 0).toLocaleString()}</td>
          <td style="text-align: center;">${statusBadge}</td>
          <td style="text-align: right; font-family: var(--font-mono); font-weight: 700; color: #a78bfa;">${Number(row.Gaptime || 0).toFixed(2)}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    console.error("Error loading legacy history:", err);
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="16" style="text-align: center; color: #f87171; padding: 24px;">ไม่สามารถดึงข้อมูลจาก Supabase ได้ในขณะนี้</td></tr>';
    }
  }
}

function exportLegacyHistoryCSV() {
  if (!cachedLegacyHistory || cachedLegacyHistory.length === 0) {
    alert("ไม่มีข้อมูลที่จะส่งออก กรุณารอข้อมูลโหลดเสร็จสิ้น");
    return;
  }

  const headers = [
    "InsNo", "LotNo", "BoxNo", "TableNo", "CheckResult",
    "CheckTime", "Checker", "StartTime", "FinishTime", "Worktype",
    "InputTotal", "OutputTotal", "Defect", "Reject", "Status", "Gaptime"
  ];

  let csvContent = "﻿" + headers.join(",") + "\r\n";

  cachedLegacyHistory.forEach(r => {
    const row = [
      `"${r.InsNo || ''}"`,
      `"${r.LotNo || ''}"`,
      `"${r.BoxNo || ''}"`,
      `"${r.TableNo || ''}"`,
      `"${r.CheckResult || ''}"`,
      `"${r.CheckTime || ''}"`,
      `"${r.Checker || ''}"`,
      `"${r.StartTime || ''}"`,
      `"${r.FinishTime || ''}"`,
      `"${r.Worktype || ''}"`,
      r.InputTotal || 0,
      r.OutputTotal || 0,
      r.Defect || 0,
      r.Reject || 0,
      `"${r.Status || ''}"`,
      Number(r.Gaptime || 0).toFixed(2)
    ];
    csvContent += row.join(",") + "\r\n";
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const nowStr = new Date().toISOString().slice(0, 10);
  a.download = `Murata_DX12_Legacy_Inspection_${nowStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Auto check Supabase health on load
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(checkSupabaseStatusManual, 1500);
  setInterval(checkSupabaseStatusManual, 60000);
});


function handleNavbarBack() {
  const tabTrace = document.getElementById("tabTrace");
  const tabSettings = document.getElementById("tabSettings");
  const tabAnalytics = document.getElementById("tabAnalytics");
  const regModal = document.getElementById("modalLotRegistration");

  // 1. If currently in History (Traceability): Return to Live / Active Stage
  if (tabTrace && tabTrace.style.display !== "none") {
    returnFromLotHistory();
    return;
  }

  // 2. If in Hardware Settings or Analytics: Switch to Live tab
  if ((tabSettings && tabSettings.style.display !== "none") || (tabAnalytics && tabAnalytics.style.display !== "none")) {
    switchTab("live");
    return;
  }

  // 3. If in modalLotRegistration
  if (regModal && (regModal.style.display === "flex" || regModal.classList.contains("active"))) {
    if (isCurrentInStage2) {
      backToStage1();
    } else {
      closeModal("modalLotRegistration");
      openPreLotModal(true);
    }
    return;
  }

  // 4. Default: If on Live screen and there is an active lot, open Stage 2
  if (currentLotData && currentLotData.lot_number) {
    openLotRegScreen(true, isCurrentInStage2);
  } else {
    openPreLotModal(true);
  }
}


// ============================================================================
// 👥 COLLABORATIVE MULTI-STATION PACKING & SHARED LOT FUNCTIONS
// ============================================================================

function getStationTableNo() {
  return localStorage.getItem("cira_station_table_no") || "Offline07";
}

function setStationTableNo(tableNo) {
  if (!tableNo) return;
  const clean = tableNo.trim();
  localStorage.setItem("cira_station_table_no", clean);
  
  const preTable = document.getElementById("preTableNo");
  const joinTable = document.getElementById("joinTableNo");
  const regTable = document.getElementById("regTableNo");
  const settingTable = document.getElementById("settingStationTableNo");
  if (preTable) preTable.value = clean;
  if (joinTable) joinTable.value = clean;
  if (regTable) regTable.value = clean;
  if (settingTable) settingTable.value = clean;

  fetch("/api/station/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table_no: clean })
  }).catch(() => {});
}

function handleStationTableChange(val) {
  if (val && val.trim()) {
    localStorage.setItem("cira_station_table_no", val.trim());
  }
}

function saveStationTableSetting() {
  const input = document.getElementById("settingStationTableNo");
  const tableNo = input ? input.value.trim() : "";
  if (!tableNo) {
    alert("กรุณากรอกหมายเลขโต๊ะตรวจงาน (เช่น Offline07 หรือ Offline08)");
    return;
  }
  setStationTableNo(tableNo);
  addNotification("บันทึกโต๊ะตรวจงาน", `ตั้งค่าหมายเลขโต๊ะเป็น "${tableNo}" เรียบร้อยแล้ว`, "success");
  alert(`✅ บันทึกหมายเลขโต๊ะ "${tableNo}" สำหรับเครื่องนี้เรียบร้อยแล้ว`);
}

let currentPreLotMode = "new";
let activeLotsCache = [];

function switchPreLotMode(mode) {
  currentPreLotMode = mode;
  const btnNew = document.getElementById("btnModeNewLot");
  const btnJoin = document.getElementById("btnModeJoinLot");
  const secNew = document.getElementById("sectionNewLotMode");
  const secJoin = document.getElementById("sectionJoinLotMode");
  const title = document.getElementById("preLotTitleBanner");

  if (mode === "join") {
    if (btnNew) {
      btnNew.classList.remove("active");
      btnNew.style.background = "transparent";
      btnNew.style.color = "#94a3b8";
    }
    if (btnJoin) {
      btnJoin.classList.add("active");
      btnJoin.style.background = "#0284c7";
      btnJoin.style.color = "#ffffff";
    }
    if (secNew) secNew.style.display = "none";
    if (secJoin) secJoin.style.display = "block";
    if (title) title.textContent = "🤝 เข้าร่วมล็อตโต๊ะอื่น (Multi-Station)";
    
    const joinTable = document.getElementById("joinTableNo");
    if (joinTable) joinTable.value = getStationTableNo();
    const joinOp = document.getElementById("joinOperatorId");
    const joinName = document.getElementById("joinOperatorName");
    const savedOp = sessionStorage.getItem("cira_operator_id") || "91207";
    if (joinOp) joinOp.value = savedOp;
    if (joinName) joinName.value = sessionStorage.getItem("cira_operator_name") || "SUTHEE RACHANAKUL";
    
    fetchAndRenderActiveLots();
  } else {
    if (btnJoin) {
      btnJoin.classList.remove("active");
      btnJoin.style.background = "transparent";
      btnJoin.style.color = "#94a3b8";
    }
    if (btnNew) {
      btnNew.classList.add("active");
      btnNew.style.background = "#e11d48";
      btnNew.style.color = "#ffffff";
    }
    if (secJoin) secJoin.style.display = "none";
    if (secNew) secNew.style.display = "block";
    if (title) title.textContent = "เปิดล็อตใหม่";
    
    const preTable = document.getElementById("preTableNo");
    if (preTable) preTable.value = getStationTableNo();
  }
}

function handleJoinOperatorIdChange(val) {
  const clean = (val || "").trim();
  if (!clean) return;
  fetch(`/api/operator/lookup?id=${clean}`)
    .then(res => res.json())
    .then(d => {
      const nameInput = document.getElementById("joinOperatorName");
      if (d && d.operator_name && nameInput) {
        nameInput.value = d.operator_name;
      }
    })
    .catch(() => {});
}

async function fetchAndRenderActiveLots() {
  const select = document.getElementById("activeLotSelect");
  const preview = document.getElementById("activeLotDetailsPreview");
  const btnConfirm = document.getElementById("btnConfirmJoinLot");
  if (!select) return;

  select.innerHTML = `<option value="">-- กำลังโหลดล็อตที่กำลังเปิดอยู่... --</option>`;
  if (preview) preview.style.display = "none";
  if (btnConfirm) btnConfirm.disabled = true;

  try {
    const res = await fetch("/api/lots/active");
    const lots = await res.json();
    activeLotsCache = Array.isArray(lots) ? lots : [];

    if (activeLotsCache.length === 0) {
      select.innerHTML = `<option value="">⚠️ ไม่พบล็อตที่กำลังเปิดอยู่ (เปิดล็อตใหม่ที่โต๊ะหลักก่อน)</option>`;
      if (btnConfirm) btnConfirm.disabled = true;
      return;
    }

    select.innerHTML = `<option value="">-- กรุณาเลือกล็อตที่ต้องการช่วยตรวจ (${activeLotsCache.length} ล็อต) --</option>` +
      activeLotsCache.map(l => {
        const done = l.current_boxes_done || l.real_inspected_boxes || 0;
        const target = l.total_target_boxes || 3;
        const starter = l.table_no || "Offline07";
        const op = l.operator_name || l.operator_id || "";
        return `<option value="${l.lot_number}">${l.lot_number} | ชิ้นงาน: ${l.part_model} [คืบหน้า: ${done}/${target} กล่อง] (โต๊ะ ${starter} - ${op})</option>`;
      }).join("");

    if (activeLotsCache.length > 0) {
      select.value = activeLotsCache[0].lot_number;
      handleActiveLotSelected(activeLotsCache[0].lot_number);
    }
  } catch (err) {
    console.error("fetchAndRenderActiveLots error:", err);
    select.innerHTML = `<option value="">❌ เกิดข้อผิดพลาดในการดึงข้อมูลล็อต</option>`;
  }
}

function handleActiveLotSelected(lotNum) {
  const preview = document.getElementById("activeLotDetailsPreview");
  const btnConfirm = document.getElementById("btnConfirmJoinLot");
  if (!lotNum) {
    if (preview) preview.style.display = "none";
    if (btnConfirm) btnConfirm.disabled = true;
    return;
  }

  const lot = activeLotsCache.find(l => l.lot_number === lotNum);
  if (!lot) return;

  if (btnConfirm) btnConfirm.disabled = false;
  if (preview) {
    const done = lot.current_boxes_done || lot.real_inspected_boxes || 0;
    const target = lot.total_target_boxes || 3;
    preview.style.display = "block";
    preview.innerHTML = `
      <div style="font-weight: 700; color: #38bdf8; margin-bottom: 4px;">🎯 รายละเอียดล็อต: ${lot.lot_number}</div>
      <div>• <strong>ชิ้นงาน:</strong> ${lot.part_model || "-"}</div>
      <div>• <strong>เป้าหมายรวม:</strong> ${target} กล่อง (${lot.qty_per_box || 700} ชิ้น/กล่อง)</div>
      <div>• <strong>ตรวจเสร็จแล้วในระบบ:</strong> <span style="color:#10b981; font-weight:700;">${done} กล่อง</span> (เหลือ ${Math.max(0, target - done)} กล่อง)</div>
      <div>• <strong>โต๊ะที่เปิดล็อตเริ่มต้น:</strong> <span style="color:#fbbf24; font-weight:700;">${lot.table_no || "Offline07"}</span> (${lot.operator_name || lot.operator_id || "Aun"})</div>
    `;
  }
}

async function confirmJoinSelectedLot() {
  const select = document.getElementById("activeLotSelect");
  const lotNum = select ? select.value.trim() : "";
  if (!lotNum) {
    alert("กรุณาเลือกล็อตที่ต้องการเข้าร่วม");
    return;
  }

  const opId = (document.getElementById("joinOperatorId")?.value || "").trim() || "91207";
  const opName = (document.getElementById("joinOperatorName")?.value || "").trim() || "SUTHEE RACHANAKUL";
  const tableNo = (document.getElementById("joinTableNo")?.value || "").trim() || getStationTableNo();

  setStationTableNo(tableNo);
  sessionStorage.setItem("cira_operator_id", opId);
  sessionStorage.setItem("cira_operator_name", opName);
  sessionStorage.setItem("cira_pin_auth", "true");

  try {
    const res = await fetch("/api/lot/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lot_number: lotNum,
        operator_id: opId,
        operator_name: opName,
        table_no: tableNo
      })
    });
    const data = await res.json();
    if (!res.ok || (data && data.is_resumed === false)) {
      alert("ไม่สามารถเข้าร่วมล็อตนี้ได้: " + (data.error || "ล็อตอาจถูกปิดไปแล้ว"));
      return;
    }

    closeModal("modalPreLotSetup");
    openResumedLotScreen(data, opId, opName);
    startCollaborativeLotSync(lotNum);

    addNotification(
      "เข้าร่วมล็อตสำเร็จ",
      `เข้าร่วมช่วยตรวจล็อต ${lotNum} ที่โต๊ะ ${tableNo} เรียบร้อยแล้ว`,
      "success"
    );
  } catch (err) {
    console.error("confirmJoinSelectedLot error:", err);
    alert("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์: " + err.message);
  }
}

let collaborativeSyncInterval = null;

function startCollaborativeLotSync(lotNumber) {
  if (collaborativeSyncInterval) {
    clearInterval(collaborativeSyncInterval);
    collaborativeSyncInterval = null;
  }
  if (!lotNumber) return;

  collaborativeSyncInterval = setInterval(async () => {
    if (!isCurrentInStage2 || !currentLotData || currentLotData.lot_number !== lotNumber) {
      return;
    }
    try {
      const res = await fetch(`/api/lot/sync?lot_number=${encodeURIComponent(lotNumber)}`);
      if (!res.ok) return;
      const syncData = await res.json();
      if (!syncData || !syncData.lot_number) return;

      // 1. Update Multi-Station Collaboration Banner
      const banner = document.getElementById("regMultiStationBanner");
      const bannerDetail = document.getElementById("regMultiStationDetail");
      if (banner) {
        if (syncData.is_multi_station || (syncData.stations_involved && syncData.stations_involved.length > 1)) {
          banner.style.display = "flex";
          if (bannerDetail) {
            bannerDetail.textContent = `เชื่อมต่อ ${syncData.stations_involved.join(", ")} | ผู้ตรวจ: ${syncData.operators_involved.join(", ")} (กำลังซิงก์เรียลไทม์ 🔄)`;
          }
        } else {
          banner.style.display = "flex";
          if (bannerDetail) {
            bannerDetail.textContent = `โต๊ะ ${getStationTableNo()} กำลังทำงานล็อตนี้ (ซิงก์เรียลไทม์ 🔄)`;
          }
        }
      }

      // 2. Synchronize inspections list
      if (syncData.inspections && Array.isArray(syncData.inspections)) {
        const serverInsps = syncData.inspections.filter(i => {
          const b = String(i.box_barcode || "").toUpperCase();
          return b && !b.startsWith("DUMMY");
        });

        const currentReal = getRealInspectedBoxes();
        let needsUpdate = (serverInsps.length !== currentReal.length);
        if (!needsUpdate) {
          const curBarcodes = new Set(currentInspectedBoxes.map(b => b.box_no));
          for (const s of serverInsps) {
            if (!curBarcodes.has(s.box_barcode)) {
              needsUpdate = true;
              break;
            }
          }
        }

        if (needsUpdate) {
          currentInspectedBoxes = serverInsps.map((insp, idx) => {
            const bCode = insp.box_barcode || String(idx + 1);
            const res = (insp.final_result || insp.ai_result || "G").toUpperCase();
            return {
              cam_no: insp.camera_id || "TEST21200",
              table_no: insp.table_no || "Offline07",
              ins_no: insp.box_index || (idx + 1),
              box_no: bCode,
              result: res,
              time: insp.created_at ? formatTime(insp.created_at) : "",
              operator: insp.operator_name || insp.operator_id || "Operator",
              operator_id: insp.operator_id || "",
              operator_name: insp.operator_name || ""
            };
          });

          renderRegTable();
          calculateRegBoxes();
        }
      }
    } catch (err) {
      // Silent catch on poll
    }
  }, 3000);
}
