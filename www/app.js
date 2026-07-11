// VORTEXIA — app.js
// Auth (email+password only), dashboard, meetings, chat, whiteboard, profile.

let currentUser = null;
let currentProfile = null;
let meetingsCache = [];
let plansCache = [];
let activeChatId = null;
let chatThreadParticipantCounts = {};
let activeChatOtherUserId = null;
let chatChannel = null;
let jitsiApi = null;          // active JitsiMeetExternalAPI instance, if a call/meeting is open
let activeCallId = null;      // calls.id of the current voice call, if any (null = video meeting or nothing)
let activeCallRoomId = null;  // meetings.id the current voice call belongs to
let pendingIncomingCall = null; // the calls row shown in the incoming-call banner, if any
let pendingHandoffCall = null;  // the calls row shown in the cross-device handoff banner, if any
let dismissedHandoffCallIds = new Set();
let firedReminders = new Set();

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function showToast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.add("hidden"), ms);
}

function authMsg(text, kind) {
  const el = $("authMsg");
  if (!text) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="authMsg ${kind}">${text}</div>`;
}

function populateTimezones(selectEl) {
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch (e) {
    zones = ["UTC","Asia/Manila","Asia/Tokyo","Asia/Singapore","Asia/Hong_Kong","Europe/London","Europe/Berlin","America/New_York","America/Los_Angeles","America/Chicago","Australia/Sydney"];
  }
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  selectEl.innerHTML = zones.map(z => `<option value="${z}" ${z===guess?"selected":""}>${z}</option>`).join("");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// First-run flow: Splash -> Onboarding -> Gender select -> Auth
// ---------------------------------------------------------------------------
const LS_ONBOARDED = "mg_onboarded";
const LS_GENDER_DONE = "mg_gender_done";
const LS_GENDER_VALUE = "mg_gender";

function hideAllFirstRunScreens() {
  $("splashWrap").classList.add("hidden");
  $("onboardWrap").classList.add("hidden");
  $("genderWrap").classList.add("hidden");
}

function showAuthScreen() {
  hideAllFirstRunScreens();
  $("authWrap").classList.remove("hidden");
}

function showGenderSelectScreen() {
  hideAllFirstRunScreens();
  $("genderWrap").classList.remove("hidden");
}

function showOnboardingScreen() {
  hideAllFirstRunScreens();
  $("onboardWrap").classList.remove("hidden");
  obIndex = 0;
  updateOnboardUI();
}

function afterOnboardingOrGenderDone() {
  if (!localStorage.getItem(LS_GENDER_DONE)) showGenderSelectScreen();
  else showAuthScreen();
}

// --- Onboarding slide logic ---
let obIndex = 0;
const OB_TOTAL = 3;

function updateOnboardUI() {
  document.querySelectorAll("#onboardDots .onboardDot").forEach((d, i) => d.classList.toggle("active", i === obIndex));
  $("btnOnboardNext").textContent = obIndex === OB_TOTAL - 1 ? "Get Started" : "Next";
}

function scrollToObSlide(i) {
  const track = $("onboardTrack");
  track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" });
  obIndex = i;
  updateOnboardUI();
}

function completeOnboarding() {
  localStorage.setItem(LS_ONBOARDED, "1");
  afterOnboardingOrGenderDone();
}

$("btnOnboardNext").addEventListener("click", () => {
  if (obIndex < OB_TOTAL - 1) scrollToObSlide(obIndex + 1);
  else completeOnboarding();
});
$("btnOnboardSkip").addEventListener("click", completeOnboarding);

let obScrollTimer = null;
$("onboardTrack").addEventListener("scroll", () => {
  clearTimeout(obScrollTimer);
  obScrollTimer = setTimeout(() => {
    const track = $("onboardTrack");
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== obIndex) { obIndex = i; updateOnboardUI(); }
  }, 80);
});

// --- Gender select logic ---
let selectedGender = null;
function selectGenderCard(which) {
  selectedGender = which;
  $("genderCardMale").classList.toggle("selected", which === "male");
  $("genderCardFemale").classList.toggle("selected", which === "female");
}
$("genderCardMale").addEventListener("click", () => selectGenderCard("male"));
$("genderCardFemale").addEventListener("click", () => selectGenderCard("female"));

function finishGenderSelect(skip) {
  if (!skip && selectedGender) localStorage.setItem(LS_GENDER_VALUE, selectedGender);
  localStorage.setItem(LS_GENDER_DONE, "1");
  showAuthScreen();
}
$("btnGenderContinue").addEventListener("click", () => finishGenderSelect(false));
$("btnGenderSkip").addEventListener("click", () => finishGenderSelect(true));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$("tabLogin").addEventListener("click", () => switchAuthTab("login"));
$("tabSignup").addEventListener("click", () => switchAuthTab("signup"));

function switchAuthTab(which) {
  authMsg("");
  $("tabLogin").classList.toggle("active", which === "login");
  $("tabSignup").classList.toggle("active", which === "signup");
  $("formLogin").classList.toggle("hidden", which !== "login");
  $("formSignup").classList.toggle("hidden", which !== "signup");
}

$("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg("");
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  $("btnDoLogin").disabled = true;
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  $("btnDoLogin").disabled = false;
  if (error) { authMsg(error.message, "err"); return; }
  await requireMfaIfNeeded(data.user);
});

$("formSignup").addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg("");
  const full_name = $("signupName").value.trim();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  $("btnDoSignup").disabled = true;
  const { data, error } = await supabaseClient.auth.signUp({
    email, password,
    options: { data: { full_name } },
  });
  $("btnDoSignup").disabled = false;
  if (error) { authMsg(error.message, "err"); return; }

  if (data.user && !data.session) {
    authMsg("Account created! Please check your email to confirm, then log in.", "ok");
    switchAuthTab("login");
    return;
  }
  if (data.user) {
    // Make sure profile has the chosen full name (trigger creates the row with email only)
    await supabaseClient.from("profiles").update({ full_name }).eq("id", data.user.id);
    await onLoggedIn(data.user);
  }
});

$("btnLogout").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentUser = null; currentProfile = null;
  $("app").classList.add("hidden");
  $("authWrap").classList.remove("hidden");
});

/* ---------- 2FA login gate: prompt for TOTP code if account requires it ---------- */
async function requireMfaIfNeeded(user) {
  const { data: aal, error: aalErr } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalErr) { console.error("MFA check failed:", aalErr); await onLoggedIn(user); return; }

  if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
    const { data: factorsData } = await supabaseClient.auth.mfa.listFactors();
    const factor = (factorsData?.totp || []).find(f => f.status === "verified");
    if (!factor) { await onLoggedIn(user); return; }

    openModal(`
      <div class="modalTitle">Enter your 2FA code</div>
      <div class="itemMeta" style="margin-bottom:14px">Open your authenticator app and enter the 6-digit code to finish signing in.</div>
      <div class="field"><input type="text" id="loginTwofaCode" maxlength="6" placeholder="123456" /></div>
      <div id="loginTwofaErr" class="itemMeta" style="color:var(--danger);min-height:16px;margin-top:6px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btnPrimary" id="loginTwofaSubmit">Verify</button>
      </div>
    `);
    return new Promise((resolve) => {
      $("loginTwofaSubmit").addEventListener("click", async () => {
        const code = $("loginTwofaCode").value.trim();
        if (!/^\d{6}$/.test(code)) { $("loginTwofaErr").textContent = "Enter the 6-digit code."; return; }
        const { data: challengeData, error: challengeErr } = await supabaseClient.auth.mfa.challenge({ factorId: factor.id });
        if (challengeErr) { $("loginTwofaErr").textContent = challengeErr.message; return; }
        const { error: verifyErr } = await supabaseClient.auth.mfa.verify({ factorId: factor.id, challengeId: challengeData.id, code });
        if (verifyErr) { $("loginTwofaErr").textContent = "Incorrect code, try again."; return; }
        closeModal();
        await onLoggedIn(user);
        resolve();
      });
    });
  }

  await onLoggedIn(user);
}

async function onLoggedIn(user) {
  currentUser = user;
  $("authWrap").classList.add("hidden");
  $("app").classList.remove("hidden");
  populateTimezones($("mTimezone"));
  populateTimezones($("pTimezone"));
  startPresenceHeartbeat();
  await loadPlans();
  await loadProfile();
  await loadMeetings();
  await loadChatThreads();
  renderActiveStatusBar();
  await loadCallHistory();
  await loadMutedChats(); // Phase 3: load muted chats
  refreshNotifBadge();
  startGlobalCallListener();
  startHandoffCheckLoop();
  startReminderLoop();
  handleVipRedirectParam();
}

async function loadPlans() {
  const { data, error } = await supabaseClient.from("plans").select("*").order("sort_order", { ascending: true });
  if (error) { console.error(error); return; }
  plansCache = data || [];
}

function handleVipRedirectParam() {
  const params = new URLSearchParams(location.search);
  const vip = params.get("vip");
  if (vip === "success") {
    showToast("Payment received! Your membership will activate shortly.");
  } else if (vip === "cancelled") {
    showToast("Checkout cancelled — no charge was made.");
  }
  if (vip) {
    params.delete("vip");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
  }
}

async function bootstrapSession() {
  const minSplashDelay = new Promise((res) => setTimeout(res, 2000));
  const { data } = await supabaseClient.auth.getSession();
  await minSplashDelay;
  hideAllFirstRunScreens();

  if (data.session && data.session.user) {
    await requireMfaIfNeeded(data.session.user);
    return;
  }

  if (!localStorage.getItem(LS_ONBOARDED)) showOnboardingScreen();
  else afterOnboardingOrGenderDone();
}
bootstrapSession();

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const VIEW_TITLES = { dashboard: "Home", meetings: "Meetings", chat: "Chats", recordings: "Recordings", notifications: "Notifications", whiteboard: "Whiteboard", profile: "Profile", more: "Community" };

function setActiveView(view) {
  document.querySelectorAll(".navTab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("view" + view.charAt(0).toUpperCase() + view.slice(1)).classList.add("active");
  $("pageTitle").textContent = VIEW_TITLES[view] || view;
  if (view === "profile") $("pageSubtitle").textContent = "Account & settings";
  else if (view === "notifications") { $("pageSubtitle").textContent = ""; loadNotifications(); }
  else if (view === "recordings") { $("pageSubtitle").textContent = ""; renderRecordingsList(); }
  else if (view === "dashboard") { $("pageSubtitle").textContent = ""; loadFeed(); }
  else if (view === "more") { $("pageSubtitle").textContent = "Marketplace, forum & announcements"; loadFeed(); loadJobs(); loadForum(); loadCommunityStats(); }
  else $("pageSubtitle").textContent = "";
  if (view === "whiteboard" && !wbRoomId) renderWhiteboardPicker();
}

document.getElementById("navTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".navTab");
  if (!btn) return;
  setActiveView(btn.dataset.view);
});

$("btnProfileTop").addEventListener("click", () => setActiveView("profile"));

$("btnSettingsTop").addEventListener("click", () => {
  setActiveView("profile");
  setTimeout(() => $("settingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
});

function updateDashboardSubtitle() {
  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 18) greeting = "Good afternoon";
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("pageSubtitle").textContent = `${greeting} • ${today}`;
}

$("qaSchedule").addEventListener("click", () => setActiveView("meetings"));
$("qaRecordings").addEventListener("click", () => setActiveView("recordings"));
$("qaInstant").addEventListener("click", startInstantMeeting);
$("backFromMeetings").addEventListener("click", () => setActiveView("dashboard"));
$("backFromRecordings").addEventListener("click", () => setActiveView("dashboard"));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
async function loadProfile() {
  const { data, error } = await supabaseClient.from("profiles").select("*").eq("id", currentUser.id).single();
  if (error) { console.error(error); return; }
  currentProfile = data;
  renderProfile();
}

function renderProfile() {
  const p = currentProfile;
  const membership = computeMembershipStatus(p);
  const isVip = membership.state === "trialing" || membership.state === "active";
  $("dashName").textContent = p.full_name || "Welcome";
  $("dashEmail").textContent = p.email || "";
  const initials = (p.full_name || "").trim().split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  $("dashAvatarInitial").textContent = initials || "🙂";
  $("pName").value = p.full_name || "";
  $("pBio").value = p.bio || "";
  $("pAvatar").value = p.avatar_url || "";
  $("pEmail").value = p.email || "";
  $("pTimezone").value = p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("pLanguage").value = p.language || "en";

  [ "planBadge", "dashPlanBadge", "profilePlanBadge" ].forEach(id => {
    const el = $(id);
    el.textContent = isVip ? "👑 VIP Verified" : "Free";
    el.className = "badge " + (isVip ? "badgeVip" : "badgeFree");
  });

  renderAiCompanion(isVip);
  renderMembershipSection(membership);

  const quotaBytes = isVip ? null : 1024 * 1024 * 1024; // 1GB free tier
  const used = p.storage_used_bytes || 0;
  const usedMb = (used / (1024*1024)).toFixed(1);
  if (quotaBytes) {
    const pct = Math.min(100, (used / quotaBytes) * 100);
    $("storageBar").style.width = pct + "%";
    $("storageLabel").textContent = `${usedMb} MB of 1 GB used`;
  } else {
    $("storageBar").style.width = "8%";
    $("storageLabel").textContent = `${usedMb} MB used • Unlimited (VIP)`;
  }
}

$("btnSaveProfile").addEventListener("click", async () => {
  const updates = {
    full_name: $("pName").value.trim(),
    bio: $("pBio").value.trim(),
    avatar_url: $("pAvatar").value.trim(),
    timezone: $("pTimezone").value,
    language: $("pLanguage").value,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseClient.from("profiles").update(updates).eq("id", currentUser.id);
  if (error) { showToast("Could not save profile: " + error.message); return; }
  showToast("Profile saved.");
  await loadProfile();
});

$("btnAccount").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Account</div>
    <div class="listItem"><div class="itemTitle" style="font-size:13px">MG ID</div><span class="badge">${escapeHtml(currentProfile?.mg_id || "—")}</span></div>
    <div class="listItem"><div class="itemTitle" style="font-size:13px">Email</div><span class="itemMeta">${escapeHtml(currentProfile?.email || currentUser?.email || "")}</span></div>
    <div class="field" style="margin-top:14px"><label>New password</label><input type="password" id="pNewPassword" placeholder="At least 6 characters" /></div>
    <button class="btn btnGhost btnBlock" id="btnChangePassword">Change Password</button>
    <div class="cardTitle" style="margin-top:20px;font-size:13px">Danger zone</div>
    <button class="btn btnDanger btnBlock" id="btnDeleteAccount">Delete my account</button>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
  $("btnChangePassword").addEventListener("click", async () => {
    const pw = $("pNewPassword").value;
    if (!pw || pw.length < 6) { showToast("Password must be at least 6 characters."); return; }
    const { error } = await supabaseClient.auth.updateUser({ password: pw });
    if (error) { showToast("Could not update password: " + error.message); return; }
    $("pNewPassword").value = "";
    showToast("Password updated.");
  });
  $("btnDeleteAccount").addEventListener("click", doDeleteAccount);
});

async function doDeleteAccount() {
  if (!confirm("This will permanently delete your VORTEXIA account, including your profile, meetings, chats, and messages. This cannot be undone. Continue?")) return;
  const { data: sessionData } = await supabaseClient.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) { showToast("Your session expired — please log in again."); return; }
  const { error } = await supabaseClient.functions.invoke("delete-account", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) { showToast("Could not delete account: " + error.message); return; }
  await supabaseClient.auth.signOut();
  showToast("Your account has been deleted.");
  location.reload();
}

// ---------------------------------------------------------------------------
// Settings & Support (Profile tab)
// ---------------------------------------------------------------------------
const APP_VERSION = "1.3.0";
const APP_BUILD_DATE = "2026-07-07";
const SUPPORT_EMAIL = "terrencemontemayor2@gmail.com";

$("appVersionText").textContent = `v${APP_VERSION} • ${APP_BUILD_DATE}`;

// --- Privacy control (activity status, room status, DM permission) ---
$("btnPrivacyControl").addEventListener("click", () => {
  const p = currentProfile || {};
  const isVip = computeMembershipStatus(p).state === "trialing" || computeMembershipStatus(p).state === "active";
  openModal(`
    <div class="modalTitle">Privacy control</div>
    <div class="switchRow">
      <span>Show when you're active<br><span class="itemMeta">Let others see when you were last active or are currently active. Turn this off and you also won't see others' status.</span></span>
      <label class="switch"><input type="checkbox" id="toggleActivity" ${p.show_activity_status !== false ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="switchRow">
      <span>Show room status on avatar<br><span class="itemMeta">Let others see when you're in a room and join through your name. Turn this off and you also won't see others' room status.</span></span>
      <label class="switch"><input type="checkbox" id="toggleRoomStatus" ${p.show_room_status !== false ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="switchRow">
      <span>Allow DMs from everyone <span class="badge badgeVip" style="font-size:10px">VIP</span><br><span class="itemMeta">Let users you don't follow message or call you directly. VIP Verified feature.</span></span>
      <label class="switch"><input type="checkbox" id="toggleDmEveryone" ${!isVip ? "disabled" : ""} ${p.allow_dm_from_everyone !== false ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
  ["toggleActivity", "toggleRoomStatus", "toggleDmEveryone"].forEach(id => {
    $(id).addEventListener("change", async (e) => {
      const field = { toggleActivity: "show_activity_status", toggleRoomStatus: "show_room_status", toggleDmEveryone: "allow_dm_from_everyone" }[id];
      const { error } = await supabaseClient.from("profiles").update({ [field]: e.target.checked }).eq("id", currentUser.id);
      if (error) { showToast(error.message); e.target.checked = !e.target.checked; return; }
      currentProfile[field] = e.target.checked;
    });
  });
});

// --- Notifications ---
$("btnNotifSettings").addEventListener("click", () => {
  const p = currentProfile || {};
  openModal(`
    <div class="modalTitle">Notifications</div>
    <div class="switchRow"><span>Show notifications</span><label class="switch"><input type="checkbox" id="toggleNotifShow" ${p.notif_in_app !== false ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="switchRow"><span>Sound</span><label class="switch"><input type="checkbox" id="toggleNotifSound" ${p.notif_sound !== false ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="switchRow"><span>Vibration</span><label class="switch"><input type="checkbox" id="toggleNotifVibrate" ${p.notif_vibration !== false ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="switchRow"><span>Received room invitation</span><label class="switch"><input type="checkbox" id="toggleNotifInvite" ${p.notif_room_invite !== false ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="switchRow"><span>Email reminders (15 min / 5 min / start)</span><label class="switch"><input type="checkbox" id="toggleNotifEmail" ${p.notif_email !== false ? "checked" : ""}><span class="slider"></span></label></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
  const map = { toggleNotifShow: "notif_in_app", toggleNotifSound: "notif_sound", toggleNotifVibrate: "notif_vibration", toggleNotifInvite: "notif_room_invite", toggleNotifEmail: "notif_email" };
  Object.keys(map).forEach(id => {
    $(id).addEventListener("change", async (e) => {
      const field = map[id];
      const { error } = await supabaseClient.from("profiles").update({ [field]: e.target.checked }).eq("id", currentUser.id);
      if (error) { showToast(error.message); e.target.checked = !e.target.checked; return; }
      currentProfile[field] = e.target.checked;
    });
  });
});

// --- Static info pages (Terms of use, FAQ, Community guidelines, Safety advice) ---
function openTextModal(title, html) {
  openModal(`
    <div class="modalTitle">${escapeHtml(title)}</div>
    <div class="itemMeta" style="max-height:55vh;overflow-y:auto;line-height:1.55;text-align:left">${html}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
}

$("btnTermsOfUse").addEventListener("click", () => openTextModal("Terms of use", `
  <p><strong>Last updated:</strong> ${APP_BUILD_DATE}</p>
  <p>By using VORTEXIA you agree to use it lawfully, treat other users respectfully, and not use it to harass, spam, or share content that violates our Community Guidelines.</p>
  <p>You're responsible for what you post/say in meetings, chats, and calls. We may suspend or remove accounts that violate these terms or the law.</p>
  <p>The Free plan and paid plans (Essential/Growth/Business) are described in Profile → Membership; prices and features may change with notice.</p>
  <p>VORTEXIA is provided "as is" during active development — features may change or be temporarily unavailable while we improve the app.</p>
  <p>Contact: ${SUPPORT_EMAIL}</p>
`));

$("btnFaq").addEventListener("click", () => openTextModal("FAQ", `
  <p><strong>How do I find someone?</strong> Use their MG ID or name in Chat → Search, or share your own MG ID (Settings → Account) so others can find you.</p>
  <p><strong>What's an MG ID?</strong> A unique 7-digit ID every account gets automatically — a stable way to find/add someone even if their name changes.</p>
  <p><strong>Can people message me if I don't follow them?</strong> Only if you allow it in Settings → Privacy control (VIP feature).</p>
  <p><strong>How do voice calls work?</strong> App-to-app only for now (WebRTC) — start one from the 📞 button in any chat.</p>
  <p><strong>How do I delete my account?</strong> Settings → Account → Delete my account. This is permanent.</p>
  <p>More questions? Settings → Send feedback.</p>
`));

$("btnCommunityGuidelines").addEventListener("click", () => openTextModal("Community guidelines", `
  <p>Be respectful — no harassment, hate speech, or threats toward other users.</p>
  <p>No spam, scams, or impersonation.</p>
  <p>No sharing of illegal content, or content that endangers minors.</p>
  <p>Respect people's privacy — don't record or share meetings/calls without consent.</p>
  <p>Violations may lead to blocking by other users, content removal, or account suspension.</p>
  <p>Report concerns via Settings → Send feedback.</p>
`));

$("btnSafetyAdvice").addEventListener("click", () => openTextModal("Safety advice", `
  <p><strong>Platform rule violations:</strong> block the user (Settings → Blocklist) and report it to us via Send feedback.</p>
  <p><strong>About your information:</strong> only people you're meeting/chatting with can see relevant data; see Settings → Privacy policy for details.</p>
  <p><strong>Staying safe on VORTEXIA:</strong> don't share passwords or one-time codes with anyone, verify who you're talking to before sharing sensitive info, and use Privacy control to limit who can reach you.</p>
  <p><strong>About VIP:</strong> VIP Verified is a paid membership tier, not an identity verification of the other person — stay cautious regardless of badges.</p>
  <p><strong>Legal &amp; safety:</strong> for urgent safety concerns involving illegal activity, contact local authorities directly in addition to reporting to us.</p>
`));

// --- Sign out (also available from the topbar) ---
$("btnSignOutSettings").addEventListener("click", () => $("btnLogout").click());

// --- Profile view (click a name/avatar to see bio + follow) ---
$("btnProfileViewBack").addEventListener("click", () => $("profileViewOverlay").classList.add("hidden"));

async function openProfileView(userId) {
  $("profileViewBody").innerHTML = `<div class="emptyState">Loading…</div>`;
  $("profileViewOverlay").classList.remove("hidden");

  const { data, error } = await supabaseClient.rpc("get_public_profile", { p_id: userId });
  const p = Array.isArray(data) ? data[0] : data;
  if (error || !p) { $("profileViewBody").innerHTML = `<div class="emptyState">Couldn't load this profile.</div>`; return; }

  const { data: followRow } = await supabaseClient.from("follows").select("id").eq("follower_id", currentUser.id).eq("followee_id", userId).maybeSingle();
  const isFollowing = !!followRow;
  const initial = (p.full_name || "?").trim().charAt(0).toUpperCase();

  $("profileViewBody").innerHTML = `
    <div class="profileViewAvatar">${p.avatar_url ? `<img src="${escapeHtml(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>` : initial}</div>
    <div class="profileViewName">${escapeHtml(p.full_name || "VORTEXIA user")}</div>
    <div class="profileViewMeta">MG ID ${escapeHtml(p.mg_id || "—")}${p.vip_status === "active" || p.vip_status === "trialing" ? " • VIP Verified" : ""}</div>
    <div class="profileViewMeta">
      ${p.is_active === null ? "" : `<span class="profileViewStatusDot ${p.is_active ? "isActive" : ""}"></span>${p.is_active ? "Active now" : "Offline"}`}
      ${p.current_room_id ? " • In a room" : ""}
    </div>
    <div class="profileViewBio">${escapeHtml(p.bio || "No bio yet.")}</div>
    <button class="btn ${isFollowing ? "btnGhost" : "btnPrimary"}" id="btnToggleFollow">${isFollowing ? "Following ✓" : "Follow"}</button>
  `;
  $("btnToggleFollow").addEventListener("click", async () => {
    if (isFollowing) {
      await supabaseClient.from("follows").delete().eq("follower_id", currentUser.id).eq("followee_id", userId);
    } else {
      await supabaseClient.from("follows").insert({ follower_id: currentUser.id, followee_id: userId });
      createNotification({ user_id: userId, type: "new_follower", title: `${currentProfile?.full_name || "Someone"} added you as a friend`, body: null });
    }
    openProfileView(userId);
  });
}

// --- Privacy settings: Blocked users ---
$("btnPrivacyBlocks").addEventListener("click", openBlockedUsersModal);

async function openBlockedUsersModal() {
  openModal(`
    <div class="modalTitle">Privacy — Blocked users</div>
    <div class="itemMeta" style="margin-bottom:12px">Blocked people can no longer message or call you. Type their VORTEXIA email to block someone.</div>
    <div class="field"><label>Email to block</label><input type="email" id="blockEmailInput" placeholder="someone@example.com" /></div>
    <button class="btn btnDanger btnBlock" id="btnBlockSubmit" style="margin-bottom:16px">Block this person</button>
    <div class="cardTitle" style="font-size:13px;margin-bottom:6px">Currently blocked</div>
    <div id="blockList" class="list"><div class="emptyState">Loading…</div></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button class="btn btnGhost" id="modalCancel">Close</button>
    </div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
  $("btnBlockSubmit").addEventListener("click", blockUserByEmail);
  await renderBlockList();
}

async function blockUserByEmail() {
  const email = $("blockEmailInput").value.trim();
  if (!email) return;
  const { data: found } = await supabaseClient.rpc("lookup_profile_by_email", { p_email: email });
  const match = Array.isArray(found) ? found[0] : found;
  if (!match || !match.id) { showToast("No VORTEXIA account found with that email."); return; }
  if (match.id === currentUser.id) { showToast("You can't block yourself."); return; }
  const { error } = await supabaseClient.from("blocked_users").insert({ blocker_id: currentUser.id, blocked_id: match.id });
  if (error) { showToast(error.code === "23505" ? "Already blocked." : error.message); return; }
  $("blockEmailInput").value = "";
  showToast("Blocked.");
  renderBlockList();
}

async function renderBlockList() {
  const el = $("blockList");
  const { data, error } = await supabaseClient
    .from("blocked_users")
    .select("id, profiles:blocked_id(full_name)")
    .order("created_at", { ascending: false });
  if (error) { el.innerHTML = `<div class="emptyState">${escapeHtml(error.message)}</div>`; return; }
  if (!data.length) { el.innerHTML = `<div class="emptyState">No one blocked yet.</div>`; return; }
  el.innerHTML = data.map(b => `
    <div class="listItem">
      <div class="itemTitle" style="font-size:13px">${escapeHtml(b.profiles?.full_name || "Unknown user")}</div>
      <button class="btn btnGhost btnSm" data-unblock="${b.id}">Unblock</button>
    </div>`).join("");
  el.querySelectorAll("[data-unblock]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await supabaseClient.from("blocked_users").delete().eq("id", btn.dataset.unblock);
      renderBlockList();
    });
  });
}

// --- Send feedback ---
$("btnFeedback").addEventListener("click", () => {
  const subject = encodeURIComponent("VORTEXIA Feedback");
  const body = encodeURIComponent(`Hi VORTEXIA team,\n\n(Write your feedback here)\n\n—\nApp version: ${APP_VERSION}\nAccount: ${currentProfile?.full_name || ""}`);
  window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
});

// --- Clear cache ---
$("btnClearCache").addEventListener("click", () => {
  if (!confirm("This clears locally cached app data on this device and reloads VORTEXIA. Your account and data on the server are not affected. Continue?")) return;
  try {
    const keepSupabaseAuth = Object.keys(localStorage).filter(k => k.startsWith("sb-"));
    const keep = {};
    keepSupabaseAuth.forEach(k => keep[k] = localStorage.getItem(k));
    localStorage.clear();
    Object.entries(keep).forEach(([k, v]) => localStorage.setItem(k, v));
    sessionStorage.clear();
    if (window.caches) caches.keys().then(names => names.forEach(n => caches.delete(n)));
  } catch (e) { console.error(e); }
  showToast("Cache cleared.");
  setTimeout(() => location.reload(), 600);
});

// --- App support ---
$("btnAppSupport").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">App support</div>
    <div class="itemMeta" style="margin-bottom:10px">Need help with VORTEXIA? Reach us here:</div>
    <div class="listItem"><div class="itemTitle" style="font-size:13px">Email</div><a class="btn btnGhost btnSm" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></div>
    <div class="listItem"><div class="itemTitle" style="font-size:13px">Website</div><span class="itemMeta">Coming soon — a support page will be linked here once our own domain is live.</span></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
});

// --- Privacy policy ---
$("btnPrivacyPolicy").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Privacy policy</div>
    <div class="itemMeta" style="max-height:50vh;overflow-y:auto;line-height:1.5;text-align:left">
      <p><strong>Last updated:</strong> ${APP_BUILD_DATE}</p>
      <p><strong>What we collect:</strong> your name, email, and any bio/avatar you add to your profile; meetings and chat messages you create or take part in; whiteboard content you draw; basic call metadata (who, when, how long) for calls you make in the app.</p>
      <p><strong>How it's used:</strong> solely to run VORTEXIA's features for you — scheduling meetings, chat, voice calls, and optional email reminders. We don't sell your data or show ads.</p>
      <p><strong>Where it's stored:</strong> Supabase (a hosted Postgres database), with access rules that only let you and people you're meeting/chatting with see the relevant data.</p>
      <p><strong>Third parties:</strong> Jitsi Meet provides the underlying video/voice connection for calls; Resend delivers email reminders. Neither is given more than what's needed to provide those features.</p>
      <p><strong>Your controls:</strong> you can edit or delete your profile, block other users from contacting you, and permanently delete your account (Profile → Danger zone) at any time.</p>
      <p><strong>Contact:</strong> ${SUPPORT_EMAIL}</p>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
});

// --- About the developer ---
$("btnAboutDeveloper").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">About the developer</div>
    <div class="itemMeta" style="line-height:1.6">
      <p><strong>John Lloyd Salazar Biendima</strong></p>
      <p>Science City of Muñoz, 3119<br/>Nueva Ecija, Philippines</p>
      <p style="margin-top:10px">Founder &amp; developer of VORTEXIA.</p>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
});
// Membership / VIP plans
// ---------------------------------------------------------------------------
function computeMembershipStatus(p) {
  const now = Date.now();

  if (p.vip_status === "trialing" && p.trial_ends_at && new Date(p.trial_ends_at).getTime() > now) {
    return {
      state: "trialing",
      badgeText: "Free Trial",
      detail: `On the ${planName(p.plan)} trial — ends ${fmtDate(p.trial_ends_at)}.`,
    };
  }

  if (p.vip_status === "active" && (!p.vip_until || new Date(p.vip_until).getTime() > now)) {
    return {
      state: "active",
      badgeText: "VIP Verified",
      detail: p.vip_until
        ? `${planName(p.plan)} plan — active until ${fmtDate(p.vip_until)}.`
        : `${planName(p.plan)} plan — active.`,
    };
  }

  if (p.vip_status === "expired" || (p.vip_status === "trialing" && p.trial_ends_at && new Date(p.trial_ends_at).getTime() <= now)) {
    return {
      state: "expired",
      badgeText: "Expired",
      detail: `Your ${planName(p.plan)} membership has ended. Renew below to get VIP features back.`,
    };
  }

  return {
    state: "free",
    badgeText: "Free",
    detail: "Upgrade to unlock the AI Companion and more.",
  };
}

function planName(planId) {
  const plan = plansCache.find(pl => pl.id === planId);
  return plan ? plan.name : "Free";
}

function renderMembershipSection(membership) {
  $("membershipStatusBadge").textContent = membership.badgeText;
  $("membershipStatusBadge").className = "badge " + (membership.state === "free" ? "badgeFree" : "badgeVip");
  $("membershipStatusDetail").textContent = membership.detail;

  const grid = $("planGrid");
  if (!plansCache.length) { grid.innerHTML = `<div class="emptyState">Plans are unavailable right now.</div>`; return; }

  const p = currentProfile;
  const isCurrentlyEntitled = membership.state === "trialing" || membership.state === "active";

  grid.innerHTML = plansCache.map(plan => {
    const isCurrentPlan = isCurrentlyEntitled && p.plan === plan.id;
    const priceLabel = `₱${Number(plan.price_php).toLocaleString()}<span> / ${plan.billing_interval === "year" ? "year" : "month"}</span>`;

    let actionsHtml;
    if (isCurrentPlan) {
      actionsHtml = `<div class="planCurrentTag">✓ Your current plan</div>`;
    } else {
      const trialBtn = !p.has_used_trial
        ? `<button class="btn btnGhost" data-trial="${plan.id}">Start Free Trial</button>`
        : "";
      actionsHtml = `
        <div class="planActions">
          ${trialBtn}
          <button class="btn btnPrimary" data-pay="${plan.id}">Pay ₱${Number(plan.price_php).toLocaleString()}</button>
        </div>`;
    }

    return `
      <div class="planCard ${plan.is_popular ? "popular" : ""} ${isCurrentPlan ? "current" : ""}">
        ${plan.is_popular ? `<div class="planPopularTag">Most Popular</div>` : ""}
        <div class="planName">${escapeHtml(plan.name)}</div>
        <div class="planPrice">${priceLabel}</div>
        <div class="planTagline">${escapeHtml(plan.tagline || "")}</div>
        ${actionsHtml}
      </div>`;
  }).join("");

  grid.querySelectorAll("[data-trial]").forEach(btn => {
    btn.addEventListener("click", () => startFreeTrial(btn.dataset.trial));
  });
  grid.querySelectorAll("[data-pay]").forEach(btn => {
    btn.addEventListener("click", () => startCheckout(btn.dataset.pay));
  });
}

$("btnRedeemCode").addEventListener("click", async () => {
  const code = $("redeemCodeInput").value.trim();
  if (!code) { showToast("Enter a code first."); return; }
  const btn = $("btnRedeemCode");
  btn.disabled = true;
  try {
    const { data, error } = await supabaseClient.rpc("redeem_vip_code", { p_code: code });
    if (error) throw error;
    showToast("Code redeemed! +7 days added to your membership.");
    $("redeemCodeInput").value = "";
    await loadProfile();
  } catch (err) {
    showToast((err && err.message) ? err.message : "That code isn't valid or has already been used.");
  } finally {
    btn.disabled = false;
  }
});

async function startFreeTrial(planId) {
  const { error } = await supabaseClient.rpc("start_free_trial", { p_plan_id: planId });
  if (error) { showToast(error.message || "Could not start your free trial."); return; }
  showToast("Free trial started! Enjoy your VIP features.");
  await loadProfile();
}

async function startCheckout(planId) {
  showToast("Opening secure checkout…");
  try {
    const { data, error } = await supabaseClient.functions.invoke("paymongo_create_checkout", {
      body: {
        plan_id: planId,
        success_url: location.origin + location.pathname + "?vip=success",
        cancel_url: location.origin + location.pathname + "?vip=cancelled",
      },
    });
    if (error) throw error;
    if (data && data.checkout_url) {
      location.href = data.checkout_url;
    } else {
      showToast((data && data.error) ? JSON.stringify(data.error) : "Could not start checkout.");
    }
  } catch (err) {
    showToast("Could not start checkout: " + (err && err.message ? err.message : "Unknown error"));
  }
}

// ---------------------------------------------------------------------------
// AI Companion (VIP) — meeting notes / chat recaps via the groq-ai Edge Function
// ---------------------------------------------------------------------------
function renderAiCompanion(isVip) {
  $("aiCompanionLocked").classList.toggle("hidden", isVip);
  $("aiCompanionUnlocked").classList.toggle("hidden", !isVip);
  if (!isVip) return;

  const select = $("aiRoomSelect");
  const prevValue = select.value;
  const rooms = meetingsCache.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (!rooms.length) {
    select.innerHTML = `<option value="">No meetings or chats yet</option>`;
    return;
  }

  select.innerHTML = rooms.map(m => {
    const label = m.status === "chat"
      ? `Chat — ${m.title}`
      : `Meeting — ${m.title}${m.scheduled_at ? " (" + fmtDate(m.scheduled_at) + ")" : ""}`;
    return `<option value="${m.id}">${escapeHtml(label)}</option>`;
  }).join("");

  if (prevValue && rooms.some(r => r.id === prevValue)) select.value = prevValue;
}

$("btnAiGenerate").addEventListener("click", generateAiSummary);

async function generateAiSummary() {
  const roomId = $("aiRoomSelect").value;
  const box = $("aiOutputBox");
  if (!roomId) { showToast("Pumili muna ng meeting o chat."); return; }

  const room = meetingsCache.find(m => m.id === roomId);
  box.classList.remove("hidden");
  box.classList.add("aiLoading");
  box.textContent = "Generating summary…";

  const { data: msgs, error: msgError } = await supabaseClient
    .from("meeting_messages")
    .select("sender_id, body, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true });

  if (msgError) {
    box.classList.remove("aiLoading");
    box.textContent = "Could not load messages: " + msgError.message;
    return;
  }

  if (!msgs || !msgs.length) {
    box.classList.remove("aiLoading");
    box.textContent = "No messages yet in this meeting/chat to summarize.";
    return;
  }

  const senderIds = [...new Set(msgs.map(m => m.sender_id))];
  const { data: profs } = await supabaseClient.from("profiles").select("id, full_name, email").in("id", senderIds);
  const nameMap = {};
  (profs || []).forEach(p => { nameMap[p.id] = p.full_name || p.email || "Participant"; });

  const transcript = msgs
    .map(m => `${m.sender_id === currentUser.id ? "You" : (nameMap[m.sender_id] || "Participant")}: ${m.body}`)
    .join("\n");

  const prompt = `Summarize the following conversation from "${room ? room.title : "this conversation"}". ` +
    `Respond with three short sections: 1) Overview, 2) Key points, 3) Action items (write "None" if there aren't any). ` +
    `Keep it concise and use plain text with simple headings, no markdown symbols.\n\nConversation:\n${transcript}`;

  try {
    const { data, error: fnError } = await supabaseClient.functions.invoke("groq-ai", {
      body: {
        prompt,
        meta: {
          appName: "VORTEXIA",
          platform: "web",
          preferredLanguage: currentProfile.language || "en",
        },
      },
    });
    if (fnError) throw fnError;
    box.classList.remove("aiLoading");
    box.textContent = (data && data.text) ? data.text : "No summary was returned.";
  } catch (err) {
    box.classList.remove("aiLoading");
    box.textContent = "Could not generate summary: " + (err && err.message ? err.message : "Unknown error");
  }
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
$("formSchedule").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("mTitle").value.trim();
  const date = $("mDate").value;
  const time = $("mTime").value;
  const duration = parseInt($("mDuration").value, 10) || 40;
  const timezone = $("mTimezone").value;
  const passcode = $("mPasscode").value.trim() || null;
  const invitesRaw = $("mInvites").value.trim();
  const invited_emails = invitesRaw ? invitesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

  if (!date || !time) { showToast("Please pick a date and time."); return; }
  const scheduled_at = new Date(`${date}T${time}:00`).toISOString();

  const { data, error } = await supabaseClient.rpc("create_meeting", {
    p_title: title,
    p_scheduled_at: scheduled_at,
    p_duration_minutes: duration,
    p_timezone: timezone,
    p_status: "scheduled",
    p_passcode: passcode,
    p_invited_emails: invited_emails,
  });

  if (error) { showToast("Could not schedule meeting: " + error.message); return; }

  await addParticipantsByEmail(data.id, invited_emails);
  showToast("Meeting scheduled.");
  $("formSchedule").reset();
  $("mDuration").value = 40;
  await loadMeetings();
});

async function addParticipantsByEmail(meetingId, emails) {
  for (const email of emails) {
    try {
      const { data: found } = await supabaseClient.rpc("lookup_profile_by_email", { p_email: email });
      const match = Array.isArray(found) ? found[0] : found;
      if (match && match.id) {
        await supabaseClient.from("meeting_participants").insert({ room_id: meetingId, user_id: match.id, role: "member" });
      }
    } catch (err) { console.warn("lookup failed for", email, err); }
  }
}

async function startInstantMeeting() {
  const { data, error } = await supabaseClient.rpc("create_meeting", {
    p_title: "Instant Meeting",
    p_scheduled_at: new Date().toISOString(),
    p_duration_minutes: 40,
    p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    p_status: "live",
  });
  if (error) { showToast("Could not start meeting: " + error.message); return; }
  await loadMeetings();
  joinMeeting(data);
}

async function loadMeetings() {
  const { data, error } = await supabaseClient.from("meetings").select("*").order("scheduled_at", { ascending: true });
  if (error) { console.error(error); return; }
  meetingsCache = data || [];
  renderMeetings();
  renderDashboard();
  if (currentProfile) {
    const membership = computeMembershipStatus(currentProfile);
    renderAiCompanion(membership.state === "trialing" || membership.state === "active");
  }
}

function renderDashboard() {
  // Dynamic greeting based on time of day
  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 18) greeting = "Good afternoon";
  
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  $("dashGreeting").textContent = `${greeting} 👋 • ${today}`;
  
  const now = Date.now();
  const upcoming = meetingsCache.filter(m => m.status !== "chat" && m.status !== "ended" && (!m.scheduled_at || new Date(m.scheduled_at).getTime() >= now - 60*60*1000));
  const history = meetingsCache.filter(m => m.status === "ended");
  $("mUpcoming").textContent = upcoming.length;
  $("mHistory").textContent = history.length;

  if (history.length) {
    const lastMeeting = [...history].sort((a, b) => new Date(b.ended_at || b.scheduled_at) - new Date(a.ended_at || a.scheduled_at))[0];
    $("lastMeetingLabel").textContent = `Last meeting: ${fmtDate(lastMeeting.ended_at || lastMeeting.scheduled_at)} — "${lastMeeting.title || "Untitled meeting"}"`;
  } else {
    $("lastMeetingLabel").textContent = "No meetings yet.";
  }

  const list = $("dashUpcomingList");
  if (!upcoming.length) { list.innerHTML = `<div class="emptyState">No upcoming meetings yet.</div>`; return; }
  list.innerHTML = upcoming.slice(0, 5).map(m => meetingListItemHTML(m)).join("");
  bindMeetingListButtons(list);
}

function meetingListItemHTML(m) {
  const isHost = m.created_by === currentUser.id;
  return `
    <div class="listItem" data-id="${m.id}">
      <div>
        <div class="itemTitle">${escapeHtml(m.title || "Untitled meeting")}</div>
        <div class="itemMeta">${fmtDate(m.scheduled_at)} • ${m.duration_minutes} min • ${escapeHtml(m.timezone || "")} ${isHost ? "• You are host" : ""}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btnGhost btnSm" data-board="${m.id}" title="Open this meeting's whiteboard">🖊️</button>
        <button class="btn btnGhost btnSm" data-copy="${m.id}">Copy link</button>
        <button class="btn btnPrimary btnSm" data-join="${m.id}">Join</button>
      </div>
    </div>`;
}

function renderMeetings() {
  const upcoming = meetingsCache.filter(m => m.status !== "chat" && m.status !== "ended");
  const history = meetingsCache.filter(m => m.status === "ended");
  const list = $("meetingsList");
  let html = "";
  if (upcoming.length) html += upcoming.map(meetingListItemHTML).join("");
  if (history.length) {
    html += `<div class="itemMeta" style="margin-top:10px">Past meetings</div>`;
    html += history.map(m => `
      <div class="listItem" data-id="${m.id}" style="opacity:.7">
        <div>
          <div class="itemTitle">${escapeHtml(m.title || "Untitled meeting")}</div>
          <div class="itemMeta">${fmtDate(m.ended_at || m.scheduled_at)} • ended</div>
        </div>
      </div>`).join("");
  }
  list.innerHTML = html || `<div class="emptyState">No meetings yet — schedule one above or start an instant meeting from the Dashboard.</div>`;
  bindMeetingListButtons(list);
}

function bindMeetingListButtons(container) {
  container.querySelectorAll("[data-join]").forEach(b => b.addEventListener("click", () => {
    const m = meetingsCache.find(x => x.id === b.dataset.join);
    if (m) joinMeeting(m);
  }));
  container.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => {
    const m = meetingsCache.find(x => x.id === b.dataset.copy);
    if (!m) return;
    const link = `${location.origin}${location.pathname}#join=${m.meeting_code}`;
    navigator.clipboard?.writeText(link).then(() => showToast("Invite link copied."));
  }));
  container.querySelectorAll("[data-board]").forEach(b => b.addEventListener("click", () => {
    setActiveView("whiteboard");
    openWhiteboard(b.dataset.board);
  }));
}

// ---------------------------------------------------------------------------
// Pre-meeting type selector
// ---------------------------------------------------------------------------
let pendingMeetingData = null;
let selectedMeetType = null;
let callTimerInterval = null;
let callStartTime = null;

function showPreMeetingSelector(meeting) {
  pendingMeetingData = meeting;
  selectedMeetType = null;
  $("preMeetingTitle").textContent = meeting.title || "Start a Meeting";
  document.querySelectorAll(".meetTypeBtn").forEach(b => b.classList.remove("selected"));
  $("btnPreMeetingGo").classList.add("hidden");
  $("preMeetingWrap").classList.remove("hidden");
}

document.querySelectorAll(".meetTypeBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".meetTypeBtn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMeetType = btn.dataset.type;
    $("btnPreMeetingGo").classList.remove("hidden");
  });
});

$("btnPreMeetingGo").addEventListener("click", () => {
  if (!selectedMeetType || !pendingMeetingData) return;
  $("preMeetingWrap").classList.add("hidden");
  const room = `meetandgreet-${pendingMeetingData.meeting_code}`;
  openJitsiCall({ room, title: pendingMeetingData.title || "Meeting", audioOnly: false, showCamBtn: true });
});

$("btnPreMeetingCancel").addEventListener("click", () => {
  $("preMeetingWrap").classList.add("hidden");
  pendingMeetingData = null;
  selectedMeetType = null;
});

function joinMeeting(meeting) {
  showPreMeetingSelector(meeting);
}

// ---------------------------------------------------------------------------
// Call timer
// ---------------------------------------------------------------------------
function startCallTimer() {
  callStartTime = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    $("callTimer").textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  $("callTimer").textContent = "00:00";
}

// ---------------------------------------------------------------------------
// Opens a call using Jitsi Meet External API — Jitsi UI fully hidden,
// we render our own green control bar.
// ---------------------------------------------------------------------------
const JAAS_APP_ID = "vpaas-magic-cookie-1e254220db684bd282fcdad0095a4fee";

async function openJitsiCall({ room, title, audioOnly, showCamBtn }) {
  $("callTitleText").textContent = title || "Call";
  $("jitsiContainer").innerHTML = "";
  $("btnToggleCam").classList.toggle("hidden", !showCamBtn);
  $("btnToggleShare").classList.toggle("hidden", !showCamBtn);
  $("btnToggleMic").classList.remove("isOff");
  $("micLabel").textContent = "Mute";
  $("btnToggleCam").classList.remove("isOff");
  $("camLabel").textContent = "Video";
  $("callParticipantCount").textContent = "👤 1";
  $("callFrameWrap").classList.remove("hidden");
  startCallTimer();

  // Get a signed JaaS JWT from our Edge Function so we don't need Jitsi login.
  let jwtToken = null;
  try {
    const { data, error } = await supabaseClient.functions.invoke("generate-jaas-jwt", {
      body: {
        roomName: room,
        userName: currentProfile?.full_name || "Guest",
        userEmail: currentUser?.email || "",
        userId: currentUser?.id || "",
      },
    });
    if (error) throw error;
    jwtToken = data?.token || null;
  } catch (err) {
    console.error("generate-jaas-jwt failed:", err);
    showToast("Hindi ma-start ang call (JWT error). Subukan ulit.");
    $("callFrameWrap").classList.add("hidden");
    stopCallTimer();
    return;
  }

  jitsiApi = new JitsiMeetExternalAPI("8x8.vc", {
    roomName: JAAS_APP_ID + "/" + room,
    jwt: jwtToken,
    parentNode: $("jitsiContainer"),
    userInfo: { displayName: currentProfile?.full_name || "Guest" },
    configOverwrite: {
      startAudioOnly: !!audioOnly,
      startWithVideoMuted: !!audioOnly,
      prejoinPageEnabled: false,
      disableInviteFunctions: true,
      disableDeepLinking: true,
      requireDisplayName: false,
      toolbarButtons: [],
      subject: title || "Meeting",
    },
    interfaceConfigOverwrite: {
      TOOLBAR_BUTTONS: [],
      SHOW_JITSI_WATERMARK: false,
      SHOW_WATERMARK_FOR_GUESTS: false,
      DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
      MOBILE_APP_PROMO: false,
    },
  });

  jitsiApi.addEventListener("audioMuteStatusChanged", (e) => {
    $("btnToggleMic").classList.toggle("isOff", e.muted);
    $("micLabel").textContent = e.muted ? "Unmute" : "Mute";
  });
  jitsiApi.addEventListener("videoMuteStatusChanged", (e) => {
    $("btnToggleCam").classList.toggle("isOff", e.muted);
    $("camLabel").textContent = e.muted ? "Start" : "Stop";
  });
  jitsiApi.addEventListener("screenSharingStatusChanged", (e) => {
    $("btnToggleShare").classList.toggle("isOn", e.on);
  });
  jitsiApi.addEventListener("participantJoined", () => {
    const count = (jitsiApi.getNumberOfParticipants?.() || 1);
    $("callParticipantCount").textContent = `👤 ${count}`;
  });
  jitsiApi.addEventListener("participantLeft", () => {
    const count = (jitsiApi.getNumberOfParticipants?.() || 1);
    $("callParticipantCount").textContent = `👤 ${count}`;
  });
  // If user closes Jitsi from inside, sync our UI
  jitsiApi.addEventListener("readyToClose", () => $("btnLeaveCall").click());
}

function closeCallUI() {
  if (jitsiApi) { jitsiApi.dispose(); jitsiApi = null; }
  $("jitsiContainer").innerHTML = "";
  $("callFrameWrap").classList.add("hidden");
  stopCallTimer();
}

$("btnToggleMic").addEventListener("click", () => jitsiApi?.executeCommand("toggleAudio"));
$("btnToggleCam").addEventListener("click", () => jitsiApi?.executeCommand("toggleVideo"));
$("btnToggleChatCall").addEventListener("click", () => jitsiApi?.executeCommand("toggleChat"));
$("btnToggleShare").addEventListener("click", () => jitsiApi?.executeCommand("toggleShareScreen"));

$("btnLeaveCall").addEventListener("click", async () => {
  closeCallUI();
  if (activeCallId) {
    const endedCallId = activeCallId;
    activeCallId = null;
    activeCallRoomId = null;
    await supabaseClient.from("call_participants").update({ left_at: new Date().toISOString() }).eq("call_id", endedCallId).eq("user_id", currentUser.id);
    await supabaseClient.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", endedCallId);
    loadCallHistory();
  }
});

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Reminders (in-app; email reminders require a scheduled backend job — see README)
// ---------------------------------------------------------------------------
function startReminderLoop() {
  checkReminders();
  setInterval(checkReminders, 30 * 1000);
}
function checkReminders() {
  if (!currentProfile || currentProfile.notif_in_app === false) return;
  const now = Date.now();
  for (const m of meetingsCache) {
    if (!m.scheduled_at || m.status === "chat" || m.status === "ended") continue;
    const start = new Date(m.scheduled_at).getTime();
    const diffMin = (start - now) / 60000;
    [[15, "15 minutes"], [5, "5 minutes"], [0, "now"]].forEach(([mark, label]) => {
      const key = m.id + ":" + mark;
      if (!firedReminders.has(key) && diffMin <= mark && diffMin > mark - 0.5) {
        firedReminders.add(key);
        showToast(`Reminder: "${m.title}" starts ${label === "now" ? "now" : "in " + label}.`, 5000);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Chat — redesigned with search, contacts, group chats, add friends
// ---------------------------------------------------------------------------
let chatThreadsCache = [];
let allProfilesCache = new Map(); // MG ID / name cache for quick lookup

async function loadChatThreads() {
  const threads = meetingsCache.filter(m => m.status === "chat");
  chatThreadsCache = threads;

  if (threads.length) {
    const { data: parts } = await supabaseClient
      .from("meeting_participants")
      .select("room_id")
      .in("room_id", threads.map(t => t.id));
    const counts = {};
    (parts || []).forEach(p => { counts[p.room_id] = (counts[p.room_id] || 0) + 1; });
    chatThreadParticipantCounts = counts;
  } else {
    chatThreadParticipantCounts = {};
  }

  renderChatThreads(threads);
  renderGroupThreads(threads.filter(t => (chatThreadParticipantCounts[t.id] || 0) > 2));
  renderContactsList();
}

function renderGroupThreads(groupThreads) {
  const el = $("groupThreads");
  if (!groupThreads.length) { el.innerHTML = `<div class="emptyState">No group chats yet. Use "+ Group chat" to start one.</div>`; return; }
  el.innerHTML = groupThreads.map(t => `
    <div class="chatThread" data-thread="${t.id}">
      <div class="chatThreadName">👥 ${escapeHtml(t.title)}</div>
      <div class="chatThreadPreview">${(chatThreadParticipantCounts[t.id] || 0)} members</div>
    </div>`).join("");
  el.querySelectorAll(".chatThread").forEach(item => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".chatThread").forEach(b => b.classList.remove("active"));
      item.classList.add("active");
      selectThread(item.dataset.thread, groupThreads.find(t => t.id === item.dataset.thread));
    });
  });
}

// ---------------- Notifications ----------------
let notifCache = [];
let notifTab = "unread";

async function createNotification({ user_id, type, title, body, related_room_id }) {
  if (!user_id || user_id === currentUser.id) return; // don't notify yourself
  await supabaseClient.from("notifications").insert({
    user_id, actor_id: currentUser.id, type, title, body: body || null, related_room_id: related_room_id || null,
  });
}

async function loadNotifications() {
  const { data, error } = await supabaseClient
    .from("notifications")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) { console.error(error); return; }
  notifCache = data || [];
  renderNotifications();
  refreshNotifBadge();
}

async function refreshNotifBadge() {
  const { count } = await supabaseClient
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .eq("is_read", false);
  const badge = $("notifBadge");
  if (count && count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function notifIcon(type) {
  return { chat_message: "💬", group_invite: "👥", new_follower: "➕", reaction: "❤️", meeting_invite: "📅" }[type] || "🔔";
}

function renderNotifications() {
  const list = notifTab === "unread" ? notifCache.filter(n => !n.is_read) : notifCache;
  const el = $("notificationsList");
  if (!list.length) {
    el.innerHTML = `<div class="emptyState">${notifTab === "unread" ? "You're all caught up!" : "No notifications yet."}</div>`;
    return;
  }
  el.innerHTML = list.map(n => `
    <div class="listItem notifItem ${n.is_read ? "" : "notifUnread"}" data-notif="${n.id}">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span class="notifAvatar">${notifIcon(n.type)}</span>
        <div>
          <div class="itemTitle">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="itemMeta">${escapeHtml(n.body)}</div>` : ""}
          <div class="itemMeta" style="color:var(--faint)">${fmtDate(n.created_at)}</div>
        </div>
      </div>
      ${!n.is_read ? `<span class="notifDot"></span>` : ""}
    </div>`).join("");
  el.querySelectorAll("[data-notif]").forEach(item => {
    item.addEventListener("click", async () => {
      const n = notifCache.find(x => x.id === item.dataset.notif);
      if (!n) return;
      if (!n.is_read) {
        await supabaseClient.from("notifications").update({ is_read: true }).eq("id", n.id);
        n.is_read = true;
        renderNotifications();
        refreshNotifBadge();
      }
      if (n.related_room_id) {
        setActiveView("chat");
        const room = meetingsCache.find(m => m.id === n.related_room_id);
        selectThread(n.related_room_id, room);
      }
    });
  });
}

document.querySelectorAll("[data-notifTab]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-notifTab]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    notifTab = btn.dataset.notiftab;
    renderNotifications();
  });
});

$("btnMarkAllRead").addEventListener("click", async () => {
  await supabaseClient.from("notifications").update({ is_read: true }).eq("user_id", currentUser.id).eq("is_read", false);
  notifCache.forEach(n => n.is_read = true);
  renderNotifications();
  refreshNotifBadge();
  showToast("All notifications marked as read.");
});


function renderChatThreads(threads) {
  const el = $("chatThreads");
  if (!threads.length) { el.innerHTML = `<div class="emptyState">No conversations yet. Add friends or start a group chat to begin.</div>`; return; }
  el.innerHTML = threads.map(t => `
    <div class="chatThread" data-thread="${t.id}">
      <div class="chatThreadName">${escapeHtml(t.title)}</div>
      <div class="chatThreadPreview" id="preview-${t.id}"></div>
    </div>`).join("");
  el.querySelectorAll(".chatThread").forEach(item => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".chatThread").forEach(b => b.classList.remove("active"));
      item.classList.add("active");
      selectThread(item.dataset.thread, threads.find(t => t.id === item.dataset.thread));
    });
  });
}

async function renderContactsList() {
  const { data: follows } = await supabaseClient.from("follows").select("followee_id").eq("follower_id", currentUser.id);
  const followingIds = (follows || []).map(f => f.followee_id);
  
  if (!followingIds.length) {
    $("contactsList").innerHTML = `<div class="emptyState">You haven't followed anyone yet. Use Add friends to start.</div>`;
    return;
  }

  const { data: contacts } = await supabaseClient.from("profiles").select("id,full_name,mg_id,vip_status").in("id", followingIds);
  if (!contacts || !contacts.length) {
    $("contactsList").innerHTML = `<div class="emptyState">No contacts found.</div>`;
    return;
  }

  $("contactsList").innerHTML = contacts.map(c => `
    <div class="contactItem" data-contact-id="${c.id}">
      <div>
        <div class="contactName">${escapeHtml(c.full_name || "—")}</div>
        <div class="contactMeta">MG ID ${escapeHtml(c.mg_id || "—")}${c.vip_status === "active" || c.vip_status === "trialing" ? " • VIP Verified" : ""}</div>
      </div>
      <div class="contactActions">
        <button class="btn btnPrimary btnSm" data-action="message">💬</button>
        <button class="btn btnGhost btnSm" data-action="profile">👤</button>
      </div>
    </div>`).join("");

  $("contactsList").querySelectorAll(".contactItem").forEach(item => {
    item.querySelector('[data-action="message"]').addEventListener("click", async () => {
      const userId = item.dataset.contactId;
      await createOrStartChat(userId);
    });
    item.querySelector('[data-action="profile"]').addEventListener("click", () => {
      openProfileView(item.dataset.contactId);
    });
  });
}

async function createOrStartChat(userId) {
  // Check if 1:1 chat already exists
  const existing = chatThreadsCache.find(t => {
    const isThisUser = t.created_by === currentUser.id && t.created_by_id === userId;
    const isOtherUser = t.created_by === userId && t.created_by_id === currentUser.id;
    return isThisUser || isOtherUser;
  });
  
  if (existing) {
    selectThread(existing.id, existing);
    return;
  }

  const { data: profile } = await supabaseClient.from("profiles").select("full_name").eq("id", userId).single();
  const { data: room, error } = await supabaseClient.rpc("create_meeting", {
    p_title: `Chat with ${profile?.full_name || "User"}`,
    p_scheduled_at: new Date().toISOString(),
    p_status: "chat",
  });
  
  if (error) { showToast(error.message); return; }
  
  await supabaseClient.from("meeting_participants").insert([
    { room_id: room.id, user_id: userId, role: "member" },
  ]);

  await loadMeetings();
  await loadChatThreads();
  selectThread(room.id, room);
}

// Chat tabs: Chats vs Contacts
document.querySelectorAll(".chatTab").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".chatTab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".chatThreadsContainer").forEach(c => c.classList.remove("active"));
    $(tab + "Container").classList.add("active");
  });
});

// Search chats & contacts
let searchTimeout;
$("chatSearch").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim().toLowerCase();
  
  searchTimeout = setTimeout(() => {
    if (!query) {
      renderChatThreads(chatThreadsCache);
      return;
    }
    const filtered = chatThreadsCache.filter(t => t.title.toLowerCase().includes(query));
    renderChatThreads(filtered);
  }, 200);
});

// Add friends modal
$("btnAddFriends").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Add friends</div>
    <div class="field">
      <label>Search by name or MG ID</label>
      <input type="text" id="searchAddFriendsInput" placeholder="John Doe or 1234567" autocomplete="off" />
    </div>
    <div class="list" id="addFriendsResults"><div class="emptyState">Start typing to search…</div></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btnGhost" id="modalCancel">Close</button>
    </div>
  `);
  
  const searchInput = $("searchAddFriendsInput");
  const resultsEl = $("addFriendsResults");
  
  let searchTimer;
  searchInput.addEventListener("input", async (e) => {
    clearTimeout(searchTimer);
    const query = e.target.value.trim();
    
    if (query.length < 2) {
      resultsEl.innerHTML = `<div class="emptyState">Start typing to search…</div>`;
      return;
    }
    
    resultsEl.innerHTML = `<div class="emptyState">Searching…</div>`;
    searchTimer = setTimeout(async () => {
      try {
        const { data, error } = await supabaseClient.rpc("search_profiles", { p_query: query });
        if (error) { console.error(error); resultsEl.innerHTML = `<div class="emptyState">Search error.</div>`; return; }
        
        const results = (data || []).filter(p => p.id !== currentUser.id);
        if (!results.length) { resultsEl.innerHTML = `<div class="emptyState">No users found.</div>`; return; }
        
        resultsEl.innerHTML = results.map(p => `
          <div class="contactItem">
            <div>
              <div class="contactName">${escapeHtml(p.full_name || "—")}</div>
              <div class="contactMeta">MG ID ${escapeHtml(p.mg_id || "—")}${p.vip_status === "active" || p.vip_status === "trialing" ? " • VIP" : ""}</div>
            </div>
            <button class="btn btnPrimary btnSm" data-user-id="${p.id}" data-action="add-friend">Follow</button>
          </div>`).join("");
        
        resultsEl.querySelectorAll('[data-action="add-friend"]').forEach(btn => {
          btn.addEventListener("click", async () => {
            const userId = btn.dataset.userId;
            const { error } = await supabaseClient.from("follows").insert({ follower_id: currentUser.id, followee_id: userId });
            if (error) { showToast("Already following or error"); return; }
            btn.disabled = true;
            btn.textContent = "Following ✓";
            createNotification({ user_id: userId, type: "new_follower", title: `${currentProfile?.full_name || "Someone"} added you as a friend`, body: null });
            await renderContactsList();
            showToast("Friend added!");
          });
        });
      } catch (err) {
        console.error(err);
        resultsEl.innerHTML = `<div class="emptyState">Search error.</div>`;
      }
    }, 300);
  });
  
  searchInput.focus();
  $("modalCancel").addEventListener("click", closeModal);
});

// Group chat modal
$("btnNewGroupChat").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Start group chat</div>
    <div class="field">
      <label>Group name</label>
      <input type="text" id="groupChatName" placeholder="Project Team" />
    </div>
    <div class="field">
      <label>Add participants (select from your contacts)</label>
      <div class="list" id="groupParticipantsList"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btnGhost" id="modalCancel">Cancel</button>
      <button class="btn btnPrimary" id="createGroupBtn">Create</button>
    </div>
  `);
  
  // Load contacts for selection
  (async () => {
    const { data: follows } = await supabaseClient.from("follows").select("followee_id").eq("follower_id", currentUser.id);
    const followingIds = (follows || []).map(f => f.followee_id);
    
    if (!followingIds.length) {
      $("groupParticipantsList").innerHTML = `<div class="emptyState">Add friends first to create a group chat.</div>`;
      $("createGroupBtn").disabled = true;
      return;
    }

    const { data: contacts } = await supabaseClient.from("profiles").select("id,full_name,mg_id").in("id", followingIds);
    $("groupParticipantsList").innerHTML = (contacts || []).map(c => `
      <label style="display:flex;align-items:center;padding:8px;gap:10px;cursor:pointer">
        <input type="checkbox" value="${c.id}" class="groupMemberCheck" />
        <span>${escapeHtml(c.full_name || "—")} (${escapeHtml(c.mg_id || "—")})</span>
      </label>`).join("");
  })();
  
  $("modalCancel").addEventListener("click", closeModal);
  $("createGroupBtn").addEventListener("click", async () => {
    const name = $("groupChatName").value.trim();
    const selected = Array.from($("groupParticipantsList").querySelectorAll(".groupMemberCheck:checked")).map(c => c.value);
    
    if (!name) { showToast("Please enter a group name"); return; }
    if (!selected.length) { showToast("Please select at least one participant"); return; }
    
    const { data: room, error } = await supabaseClient.rpc("create_meeting", {
      p_title: name,
      p_scheduled_at: new Date().toISOString(),
      p_status: "chat",
    });
    
    if (error) { showToast(error.message); return; }
    
    const participants = [...selected.map(uid => ({ room_id: room.id, user_id: uid, role: "member" }))];
    await supabaseClient.from("meeting_participants").insert(participants);

    await Promise.all(selected.map(uid => createNotification({
      user_id: uid, type: "group_invite", title: `${currentProfile?.full_name || "Someone"} added you to "${name}"`,
      body: "Tap to open the group chat.", related_room_id: room.id,
    })));

    closeModal();
    await loadMeetings();
    await loadChatThreads();
    selectThread(room.id, room);
  });
});

async function selectThread(id, meta) {
  activeChatId = id;
  activeChatOtherUserId = null;
  chatPage = 0;
  allMsgsLoaded = false;
  pinnedMessages = [];
  searchQuery = "";
  msgSearchVisible = false;

  // Clean up old channels
  if (chatChannel) { supabaseClient.removeChannel(chatChannel); chatChannel = null; }
  if (typingChannel) { supabaseClient.removeChannel(typingChannel); typingChannel = null; }

  // Enable UI
  $("chatInput").disabled = false;
  $("chatSend").disabled = false;
  $("btnEmojiPicker").disabled = false;
  $("btnMsgSearch").disabled = false;
  $("btnAttach").disabled = false;
  $("chatHeaderBar").classList.remove("hidden");
  $("pinnedPanel").classList.add("hidden");

  // Apply mute state
  updateMuteButton(id);

  // Load participants
  const { data: parts } = await supabaseClient.from("meeting_participants").select("user_id").eq("room_id", id);
  const allParticipants = (parts || []).map(p => p.user_id);
  const others = allParticipants.filter(uid => uid !== currentUser.id);
  if (others.length > 0) {
    const { data: profiles } = await supabaseClient.from("profiles").select("id,full_name").in("id", others);
    const names = (profiles || []).map(p => p.full_name).join(", ");
    $("chatHeaderParticipants").textContent = others.length > 1 ? `with ${names}` : "";
    activeChatOtherUserId = others[0] || null;
  }
  $("chatHeaderTitle").textContent = meta?.title || "Chat";
  $("chatHeaderTitle").classList.add("chatHeaderTitle--clickable");

  // Load pinned messages from DB
  await loadPinnedMessages(id);

  // Load first page of messages (newest 50)
  await loadChatPage(id, true);

  // Add scroll-to-bottom button
  addScrollToBottomBtn();

  // Subscribe to new messages (realtime INSERT/UPDATE/DELETE)
  chatChannel = supabaseClient.channel("chat:" + id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "meeting_messages", filter: `room_id=eq.${id}` }, (payload) => {
      if (payload.new.sender_id !== currentUser.id) {
        appendChatMessage(payload.new);
      }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "meeting_messages", filter: `room_id=eq.${id}` }, (payload) => {
      handleMessageUpdate(payload.new);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "meeting_messages", filter: `room_id=eq.${id}` }, (payload) => {
      handleMessageDelete(payload.old?.id);
    })
    .subscribe();

  // Subscribe to typing broadcasts
  typingChannel = supabaseClient.channel("typing:" + id)
    .on("broadcast", { event: "typing" }, (payload) => {
      if (payload.payload.userId !== currentUser.id) {
        showTypingIndicator(payload.payload.userId, payload.payload.userName);
      }
    })
    .on("broadcast", { event: "stop_typing" }, (payload) => {
      if (payload.payload.userId !== currentUser.id) {
        hideTypingIndicator(payload.payload.userId);
      }
    })
    .subscribe();
}

async function loadChatPage(roomId, firstLoad = false) {
  const from = chatPage * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data, error } = await supabaseClient
    .from("meeting_messages").select("*").eq("room_id", roomId)
    .order("created_at", { ascending: false }).range(from, to);
  if (error) { console.error(error); return; }
  const msgs = (data || []).reverse();
  if (msgs.length < PAGE_SIZE) allMsgsLoaded = true;
  chatPage++;
  if (firstLoad) {
    renderChatMessages(msgs);
  } else {
    prependChatMessages(msgs);
  }
}

function prependChatMessages(msgs) {
  const el = $("chatMessages");
  const scrollBottom = el.scrollHeight - el.scrollTop;
  msgs.forEach(m => {
    messageCache.set(m.id, m);
    const group = buildMessageElement(m);
    if (el.firstChild) el.insertBefore(group, el.firstChild);
    else el.appendChild(group);
  });
  el.scrollTop = el.scrollHeight - scrollBottom;
  addLoadMoreBtn();
}

function addLoadMoreBtn() {
  const el = $("chatMessages");
  const existing = el.querySelector(".loadMoreBtn");
  if (existing) existing.remove();
  if (allMsgsLoaded) return;
  const btn = document.createElement("button");
  btn.className = "loadMoreBtn";
  btn.textContent = "Load older messages";
  btn.addEventListener("click", async () => {
    btn.textContent = "Loading…";
    btn.disabled = true;
    await loadChatPage(activeChatId, false);
  });
  el.insertBefore(btn, el.firstChild);
}

function addScrollToBottomBtn() {
  const wrap = $("chatMessages").parentElement;
  const existing = wrap.querySelector(".scrollToBottomBtn");
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.className = "scrollToBottomBtn";
  btn.title = "Scroll to bottom";
  btn.innerHTML = "↓";
  btn.style.cssText = "position:absolute;bottom:72px;right:14px;z-index:50;opacity:0;pointer-events:none;";
  wrap.style.position = "relative";
  wrap.appendChild(btn);
  btn.addEventListener("click", () => {
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  });
  $("chatMessages").addEventListener("scroll", () => {
    const el = $("chatMessages");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    btn.style.opacity = atBottom ? "0" : "1";
    btn.style.pointerEvents = atBottom ? "none" : "auto";
  });
}

$("chatHeaderTitle").addEventListener("click", () => {
  if (activeChatOtherUserId) openProfileView(activeChatOtherUserId);
});

// ========== PHASE 2: ENHANCED MESSAGE RENDERING WITH AVATARS, REACTIONS, READ RECEIPTS, TYPING INDICATORS ==========

const messageCache = new Map();
const typingUsers = new Set();
let lastMessageDate = null;
let searchQuery = "";
let filteredMessages = [];

// ========== PHASE 3 STATE ==========
let typingChannel = null;          // Supabase broadcast channel for typing
let typingTimeout = null;          // Debounce timer for sending typing events
let pendingFile = null;            // File selected for upload { file, name, size, type }
let pinnedMessages = [];           // Pinned messages for current chat (from DB)
let chatPage = 0;                  // Pagination page (50 msgs each)
const PAGE_SIZE = 50;
let allMsgsLoaded = false;         // True when no more old messages to load
let searchResultIdx = 0;           // Current highlighted search result index
let searchMatches = [];            // DOM elements matching search
let msgSearchVisible = false;      // Is search bar visible
let mutedChats = new Set();        // Set of muted chat IDs (loaded from DB on login)

function renderChatMessages(msgs) {
  const el = $("chatMessages");
  el.innerHTML = "";
  lastMessageDate = null;
  messageCache.clear();
  if (msgs.length === 0) {
    el.innerHTML = '<div class="emptyState">No messages yet. Say hello! 👋</div>';
    addLoadMoreBtn();
    return;
  }
  msgs.forEach(m => {
    messageCache.set(m.id, m);
    el.appendChild(buildMessageElement(m));
  });
  addLoadMoreBtn();
  el.scrollTop = el.scrollHeight;
}

function appendChatMessage(m, isNew = true) {
  const el = $("chatMessages");
  const emptyState = el.querySelector(".emptyState");
  if (emptyState) emptyState.remove();
  messageCache.set(m.id, m);
  el.appendChild(buildMessageElement(m));
  if (isNew) {
    setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
  }
}

function showTypingIndicator(userId, userName) {
  if (typingUsers.has(userId)) return;
  typingUsers.add(userId);
  
  const el = $("chatMessages");
  const typing = document.createElement("div");
  typing.className = "messageBubbleGroup received";
  typing.dataset.typingUserId = userId;
  typing.innerHTML = `
    <div class="messageBubbleAvatar">${(userName || "?").charAt(0).toUpperCase()}</div>
    <div class="bubbleContainer">
      <div class="messageBubbleHeader">
        <span class="messageBubbleName">${escapeHtml(userName || "User")} is typing...</span>
      </div>
      <div class="typingBubble">
        <div class="typingDot"></div>
        <div class="typingDot"></div>
        <div class="typingDot"></div>
      </div>
    </div>
  `;
  el.appendChild(typing);
  el.scrollTop = el.scrollHeight;
  
  // Remove after 3 seconds if no new typing indicator
  setTimeout(() => {
    if (typingUsers.has(userId)) {
      const el = $("chatMessages");
      const existing = el.querySelector(`[data-typing-user-id="${userId}"]`);
      if (existing) existing.remove();
      typingUsers.delete(userId);
    }
  }, 3000);
}

function hideTypingIndicator(userId) {
  typingUsers.delete(userId);
  const el = $("chatMessages");
  const existing = el.querySelector(`[data-typing-user-id="${userId}"]`);
  if (existing) existing.remove();
}

// Message search
function searchMessages(query) {
  searchQuery = query;
  const el = $("chatMessages");
  const msgs = Array.from(messageCache.values());
  
  if (!query) {
    renderChatMessages(msgs);
    return;
  }
  
  const results = msgs.filter(m => m.body.toLowerCase().includes(query.toLowerCase()));
  el.innerHTML = "";
  lastMessageDate = null;
  
  if (results.length === 0) {
    el.innerHTML = '<div class="emptyState">No messages match your search.</div>';
    return;
  }
  
  results.forEach(m => appendChatMessage(m, false));
}

// Emoji reactions
function addReaction(messageId, emoji) {
  // Simple implementation: store in messageCache
  const msg = messageCache.get(messageId);
  if (!msg) return;
  
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  if (!msg.reactions[emoji].includes(currentUser.id)) {
    msg.reactions[emoji].push(currentUser.id);
  }
  
  // Re-render reactions for this message
  const reactionDiv = document.querySelector(`[data-message-id="${messageId}"] .messageReactions`);
  if (reactionDiv) {
    reactionDiv.innerHTML = "";
    if (msg.reactions) {
      Object.entries(msg.reactions).forEach(([emoji, users]) => {
        const pill = document.createElement("button");
        pill.className = "reactionPill";
        if (users.includes(currentUser.id)) pill.classList.add("youReacted");
        pill.innerHTML = `${emoji} <span class="reactionCount">${users.length}</span>`;
        pill.addEventListener("click", () => removeReaction(messageId, emoji));
        reactionDiv.appendChild(pill);
      });
    }
  }
}

function removeReaction(messageId, emoji) {
  const msg = messageCache.get(messageId);
  if (!msg || !msg.reactions || !msg.reactions[emoji]) return;
  
  const idx = msg.reactions[emoji].indexOf(currentUser.id);
  if (idx > -1) msg.reactions[emoji].splice(idx, 1);
  if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
  
  const reactionDiv = document.querySelector(`[data-message-id="${messageId}"] .messageReactions`);
  if (reactionDiv) {
    reactionDiv.innerHTML = "";
    if (msg.reactions) {
      Object.entries(msg.reactions).forEach(([emoji, users]) => {
        const pill = document.createElement("button");
        pill.className = "reactionPill";
        if (users.includes(currentUser.id)) pill.classList.add("youReacted");
        pill.innerHTML = `${emoji} <span class="reactionCount">${users.length}</span>`;
        pill.addEventListener("click", () => removeReaction(messageId, emoji));
        reactionDiv.appendChild(pill);
      });
    }
  }
}

// Pin messages
function pinMessage(messageId) {
  const msg = messageCache.get(messageId);
  if (!msg) return;
  msg.isPinned = !msg.isPinned;
  // Visual feedback
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (msgEl) {
    msgEl.style.borderLeft = msg.isPinned ? "4px solid var(--green)" : "none";
    msgEl.style.paddingLeft = msg.isPinned ? "12px" : "0";
  }
}

// =====================================================
// PHASE 3 — CHAT FEATURES
// =====================================================

// ---- Mute (stored in profiles.muted_chats jsonb) ----
function isMuted(chatId) { return mutedChats.has(chatId); }

async function loadMutedChats() {
  const { data } = await supabaseClient.from("profiles").select("muted_chats").eq("id", currentUser.id).single();
  mutedChats = new Set(data?.muted_chats || []);
}

async function toggleMuteChat(chatId) {
  if (mutedChats.has(chatId)) {
    mutedChats.delete(chatId);
    showToast("Chat unmuted.");
  } else {
    mutedChats.add(chatId);
    showToast("Chat muted. You won't get notifications for new messages.");
  }
  await supabaseClient.from("profiles").update({ muted_chats: Array.from(mutedChats) }).eq("id", currentUser.id);
  updateMuteButton(chatId);
}

function updateMuteButton(chatId) {
  const btn = $("btnMuteChat");
  if (!btn) return;
  const muted = mutedChats.has(chatId);
  btn.textContent = muted ? "🔔" : "🔕";
  btn.title = muted ? "Unmute notifications" : "Mute notifications";
  btn.classList.toggle("active", muted);
}

$("btnMuteChat").addEventListener("click", () => {
  if (activeChatId) toggleMuteChat(activeChatId);
});

// ---- Pinned Messages (stored in meeting_messages.is_pinned) ----
async function loadPinnedMessages(roomId) {
  const { data } = await supabaseClient.from("meeting_messages")
    .select("*").eq("room_id", roomId).eq("is_pinned", true).order("created_at", { ascending: false });
  pinnedMessages = data || [];
  renderPinnedPanel();
}

function renderPinnedPanel() {
  const list = $("pinnedList");
  if (!list) return;
  if (pinnedMessages.length === 0) {
    list.innerHTML = '<div style="padding:10px 14px;font-size:13px;color:var(--muted)">No pinned messages.</div>';
    return;
  }
  list.innerHTML = "";
  pinnedMessages.forEach(m => {
    const item = document.createElement("div");
    item.className = "pinnedItem";
    const senderProfile = allProfilesCache.get(m.sender_id) || { full_name: "User" };
    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="pinnedItemMeta">${escapeHtml(senderProfile.full_name)}</div>
        <div class="pinnedItemText">${m.is_deleted ? "<em>Message deleted</em>" : escapeHtml(m.body || "")}</div>
      </div>
      <button class="unpinBtn" data-id="${m.id}" title="Unpin">✕</button>
    `;
    item.querySelector(".unpinBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      unpinMessage(m.id);
    });
    item.addEventListener("click", () => scrollToMessage(m.id));
    list.appendChild(item);
  });
}

async function togglePinMessage(messageId) {
  const msg = messageCache.get(messageId);
  if (!msg) return;
  const newPinned = !msg.is_pinned;
  const { error } = await supabaseClient.from("meeting_messages").update({ is_pinned: newPinned }).eq("id", messageId);
  if (error) { showToast("Could not update pin: " + error.message); return; }
  msg.is_pinned = newPinned;
  // Update pinned list
  if (newPinned) {
    pinnedMessages.unshift(msg);
    showToast("Message pinned.");
  } else {
    pinnedMessages = pinnedMessages.filter(p => p.id !== messageId);
    showToast("Message unpinned.");
  }
  renderPinnedPanel();
  // Update visual on bubble
  const group = document.querySelector(`.messageBubbleGroup[data-message-id="${messageId}"]`);
  if (group) group.classList.toggle("isPinned", newPinned);
  // Update pin tag in bubble
  const container = group?.querySelector(".bubbleContainer");
  let tag = container?.querySelector(".pinnedTag");
  if (newPinned && container && !tag) {
    tag = document.createElement("span");
    tag.className = "pinnedTag";
    tag.textContent = "📌 Pinned";
    container.insertBefore(tag, container.firstChild);
  } else if (!newPinned && tag) {
    tag.remove();
  }
}

async function unpinMessage(messageId) { await togglePinMessage(messageId); }

function scrollToMessage(messageId) {
  const el = document.querySelector(`.messageBubbleGroup[data-message-id="${messageId}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("btnPinList").addEventListener("click", () => {
  $("pinnedPanel").classList.toggle("hidden");
});
$("btnClosePinPanel").addEventListener("click", () => {
  $("pinnedPanel").classList.add("hidden");
});

// ---- Message Edit ----
async function editMessage(messageId) {
  const msg = messageCache.get(messageId);
  if (!msg || msg.sender_id !== currentUser.id || msg.is_deleted) return;

  const group = document.querySelector(`.messageBubbleGroup[data-message-id="${messageId}"]`);
  const textEl = group?.querySelector(".bubbleText");
  if (!textEl) return;

  const originalText = msg.body;
  textEl.classList.add("editingBubble");

  const textarea = document.createElement("textarea");
  textarea.className = "editInput";
  textarea.value = originalText;
  textarea.rows = 2;
  textEl.innerHTML = "";
  textEl.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "editActions";
  actions.innerHTML = `
    <button class="btn btnPrimary btnSm" id="saveEditBtn">Save</button>
    <button class="btn btnGhost btnSm" id="cancelEditBtn">Cancel</button>
  `;
  textEl.appendChild(actions);
  textarea.focus();

  actions.querySelector("#saveEditBtn").addEventListener("click", async () => {
    const newBody = textarea.value.trim();
    if (!newBody || newBody === originalText) {
      cancelEdit(textEl, originalText);
      return;
    }
    const { error } = await supabaseClient.from("meeting_messages")
      .update({ body: newBody, edited_at: new Date().toISOString() }).eq("id", messageId);
    if (error) { showToast("Could not edit: " + error.message); return; }
    msg.body = newBody;
    msg.edited_at = new Date().toISOString();
    textEl.classList.remove("editingBubble");
    textEl.textContent = newBody;
    const editedLabel = document.createElement("span");
    editedLabel.style.cssText = "font-size:10px;color:var(--muted);margin-left:4px;";
    editedLabel.textContent = "(edited)";
    textEl.appendChild(editedLabel);
    showToast("Message updated.");
  });

  actions.querySelector("#cancelEditBtn").addEventListener("click", () => {
    cancelEdit(textEl, originalText);
  });
}

function cancelEdit(textEl, originalText) {
  textEl.classList.remove("editingBubble");
  textEl.textContent = originalText;
}

// ---- Message Delete ----
async function deleteMessage(messageId) {
  if (!confirm("Delete this message? This cannot be undone.")) return;
  const { error } = await supabaseClient.from("meeting_messages")
    .update({ is_deleted: true, body: null }).eq("id", messageId);
  if (error) { showToast("Could not delete: " + error.message); return; }
  const msg = messageCache.get(messageId);
  if (msg) { msg.is_deleted = true; msg.body = null; }
  handleMessageDelete_local(messageId);
  showToast("Message deleted.");
}

function handleMessageDelete_local(messageId) {
  const group = document.querySelector(`.messageBubbleGroup[data-message-id="${messageId}"]`);
  const textEl = group?.querySelector(".bubbleText");
  if (textEl) {
    textEl.innerHTML = '<span class="deletedMsg">This message was deleted.</span>';
  }
  // Remove from pinned if pinned
  if (pinnedMessages.find(p => p.id === messageId)) {
    pinnedMessages = pinnedMessages.filter(p => p.id !== messageId);
    renderPinnedPanel();
  }
}

function handleMessageUpdate(newMsg) {
  const msg = messageCache.get(newMsg.id);
  if (!msg) return;
  Object.assign(msg, newMsg);
  const group = document.querySelector(`.messageBubbleGroup[data-message-id="${newMsg.id}"]`);
  const textEl = group?.querySelector(".bubbleText");
  if (!textEl) return;
  if (newMsg.is_deleted) {
    textEl.innerHTML = '<span class="deletedMsg">This message was deleted.</span>';
  } else if (newMsg.body) {
    textEl.textContent = newMsg.body;
    if (newMsg.edited_at && !textEl.querySelector(".editedLabel")) {
      const label = document.createElement("span");
      label.className = "editedLabel";
      label.style.cssText = "font-size:10px;color:var(--muted);margin-left:4px;";
      label.textContent = "(edited)";
      textEl.appendChild(label);
    }
  }
}

function handleMessageDelete(id) { if (id) handleMessageDelete_local(id); }

// ---- Context Menu (right-click / long-press on message) ----
let activeContextMenu = null;

function showMessageContextMenu(e, messageId) {
  e.preventDefault();
  closeContextMenu();
  const msg = messageCache.get(messageId);
  if (!msg) return;
  const mine = msg.sender_id === currentUser.id;

  const menu = document.createElement("div");
  menu.className = "msgContextMenu";
  activeContextMenu = menu;

  // Quick emoji reactions
  const quickEmojis = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
  const emojiRow = document.createElement("div");
  emojiRow.className = "emojiRow";
  quickEmojis.forEach(em => {
    const btn = document.createElement("button");
    btn.textContent = em;
    btn.addEventListener("click", () => { addReaction(messageId, em); closeContextMenu(); });
    emojiRow.appendChild(btn);
  });
  menu.appendChild(emojiRow);

  // Actions
  const actions = [
    { icon: "📌", label: msg.is_pinned ? "Unpin" : "Pin message", fn: () => togglePinMessage(messageId) },
    { icon: "💬", label: "Reply", fn: () => setReply(messageId) },
  ];
  if (mine && !msg.is_deleted) {
    actions.push({ icon: "✏️", label: "Edit", fn: () => editMessage(messageId) });
    actions.push({ icon: "🗑️", label: "Delete", fn: () => deleteMessage(messageId), danger: true });
  }
  actions.push({ icon: "📋", label: "Copy text", fn: () => { navigator.clipboard?.writeText(msg.body || ""); showToast("Copied!"); } });

  actions.forEach(({ icon, label, fn, danger }) => {
    const btn = document.createElement("button");
    btn.innerHTML = `<span>${icon}</span> ${label}`;
    if (danger) btn.classList.add("danger");
    btn.addEventListener("click", () => { fn(); closeContextMenu(); });
    menu.appendChild(btn);
  });

  // Position
  menu.style.position = "fixed";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + "px";
  document.body.appendChild(menu);

  setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 10);
}

function closeContextMenu() {
  if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
}

// ---- Reply to message ----
let replyToMsg = null;

function setReply(messageId) {
  const msg = messageCache.get(messageId);
  if (!msg) return;
  replyToMsg = msg;
  const senderProfile = allProfilesCache.get(msg.sender_id) || { full_name: "User" };
  let replyBar = $("replyBar");
  if (!replyBar) {
    replyBar = document.createElement("div");
    replyBar.id = "replyBar";
    replyBar.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--greenSoft);border-top:1px solid var(--border);font-size:12px;color:var(--text)";
    const composer = document.querySelector(".chatComposer");
    composer.parentElement.insertBefore(replyBar, composer);
  }
  replyBar.innerHTML = `
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ↩️ Replying to <strong>${escapeHtml(senderProfile.full_name)}</strong>: ${escapeHtml((msg.body || "").slice(0, 60))}
    </span>
    <button onclick="clearReply()" style="background:none;border:none;cursor:pointer;font-size:16px">✕</button>
  `;
  $("chatInput").focus();
}

function clearReply() {
  replyToMsg = null;
  const bar = $("replyBar");
  if (bar) bar.remove();
}

// ---- File Attach ----
$("btnAttach").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { showToast("File too large (max 10 MB)"); return; }
  pendingFile = file;
  $("filePreviewName").textContent = `📎 ${file.name} (${formatFileSize(file.size)})`;
  $("filePreviewBar").classList.remove("hidden");
  $("fileInput").value = "";
});

$("btnCancelFile").addEventListener("click", () => {
  pendingFile = null;
  $("filePreviewBar").classList.add("hidden");
  $("filePreviewName").textContent = "";
});

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function uploadFileToSupabase(file) {
  const ext = file.name.split(".").pop();
  const path = `chat/${activeChatId}/${Date.now()}_${currentUser.id}.${ext}`;
  const { data, error } = await supabaseClient.storage.from("chat-files").upload(path, file);
  if (error) throw error;
  const { data: urlData } = supabaseClient.storage.from("chat-files").getPublicUrl(path);
  return { url: urlData.publicUrl, name: file.name, size: file.size, type: file.type };
}

// ---- Send Message (upgraded) ----
$("chatSend").addEventListener("click", sendChatMessage);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) sendChatMessage();
});

// Typing broadcast on input
$("chatInput").addEventListener("input", () => {
  if (!typingChannel || !activeChatId) return;
  typingChannel.send({ type: "broadcast", event: "typing", payload: { userId: currentUser.id, userName: currentProfile?.full_name || "User" } });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingChannel?.send({ type: "broadcast", event: "stop_typing", payload: { userId: currentUser.id } });
  }, 2500);
});

async function sendChatMessage() {
  const body = $("chatInput").value.trim();
  if (!body && !pendingFile) return;
  if (!activeChatId) return;

  $("chatInput").value = "";
  // Stop typing indicator
  clearTimeout(typingTimeout);
  typingChannel?.send({ type: "broadcast", event: "stop_typing", payload: { userId: currentUser.id } });

  let fileData = null;

  // Handle file upload
  if (pendingFile) {
    const file = pendingFile;
    pendingFile = null;
    $("filePreviewBar").classList.add("hidden");
    try {
      fileData = await uploadFileToSupabase(file);
    } catch (err) {
      showToast("File upload failed: " + (err.message || "Storage bucket not set up yet"));
      // Fall through — send text only if there is some
      if (!body) return;
    }
  }

  // Build message object
  const msgObj = {
    room_id: activeChatId,
    sender_id: currentUser.id,
    body: body || (fileData ? fileData.name : ""),
    reply_to_id: replyToMsg?.id || null,
    file_url: fileData?.url || null,
    file_name: fileData?.name || null,
    file_size: fileData?.size || null,
    file_type: fileData?.type || null,
  };

  clearReply();

  // Optimistic append
  const tempMsg = { ...msgObj, id: "temp_" + Date.now(), created_at: new Date().toISOString() };
  appendChatMessage(tempMsg);

  const { data: inserted, error } = await supabaseClient.from("meeting_messages").insert(msgObj).select().single();
  if (error) {
    showToast(error.message);
    // Remove temp
    const tempEl = document.querySelector(`[data-message-id="${tempMsg.id}"]`);
    if (tempEl) tempEl.remove();
    return;
  }

  // Replace temp with real message
  const tempEl = document.querySelector(`[data-message-id="${tempMsg.id}"]`);
  if (tempEl) {
    tempEl.dataset.messageId = inserted.id;
    messageCache.delete(tempMsg.id);
    messageCache.set(inserted.id, inserted);
  }

  notifyOtherParticipants(activeChatId, "chat_message", currentProfile?.full_name || "Someone", body || "Sent an attachment");
}

async function notifyOtherParticipants(roomId, type, title, body) {
  try {
    const { data: parts } = await supabaseClient.from("meeting_participants").select("user_id").eq("room_id", roomId);
    const others = (parts || []).map(p => p.user_id).filter(id => id !== currentUser.id);
    if (!others.length) return;
    await Promise.all(others.map(uid => createNotification({
      user_id: uid, type, title, body: body?.slice(0, 120), related_room_id: roomId,
    })));
  } catch (err) { console.error("notify error", err); }
}

// ---- Emoji Picker ----
const EMOJI_LIST = ["😀","😂","🥹","😍","🤔","😎","😭","🥺","😡","🤯","👍","👎","❤️","🔥","✨","🎉","💯","🙏","👋","💪","🤝","😊","🥰","😏","😜","🫡","🤣","😢","😤","🙄","💀","🫶","💔","💕","😆","😅","🤗","😴","🤮","🤑","🎊","🏆","🌟","💫","⚡","🎯","🚀","💡","🌈","🦋"];

function initEmojiPicker() {
  const grid = $("emojiGrid");
  if (!grid) return;
  grid.innerHTML = "";
  EMOJI_LIST.forEach(em => {
    const btn = document.createElement("button");
    btn.textContent = em;
    btn.addEventListener("click", () => {
      const input = $("chatInput");
      const pos = input.selectionStart;
      const val = input.value;
      input.value = val.slice(0, pos) + em + val.slice(pos);
      input.selectionStart = input.selectionEnd = pos + em.length;
      input.focus();
      $("emojiPickerPopover").classList.add("hidden");
    });
    grid.appendChild(btn);
  });
}

$("btnEmojiPicker").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("emojiPickerPopover");
  pop.classList.toggle("hidden");
  if (!pop.classList.contains("hidden")) initEmojiPicker();
});
document.addEventListener("click", () => $("emojiPickerPopover")?.classList.add("hidden"));
$("emojiPickerPopover")?.addEventListener("click", e => e.stopPropagation());

// ---- Message Search (in-chat) ----
let msgSearchBar = null;

$("btnMsgSearch").addEventListener("click", () => {
  toggleMsgSearch();
});

function toggleMsgSearch() {
  msgSearchVisible = !msgSearchVisible;
  if (msgSearchVisible) {
    showMsgSearchBar();
  } else {
    hideMsgSearchBar();
  }
}

function showMsgSearchBar() {
  if ($("msgSearchBar")) return;
  const bar = document.createElement("div");
  bar.id = "msgSearchBar";
  bar.className = "msgSearchBar";
  bar.innerHTML = `
    <input type="text" id="msgSearchInput" placeholder="Search messages…" autocomplete="off"/>
    <div class="searchNav">
      <span id="searchCount"></span>
      <button id="searchPrev" title="Previous">↑</button>
      <button id="searchNext" title="Next">↓</button>
      <button id="closeSearch" title="Close search">✕</button>
    </div>
  `;
  const composer = document.querySelector(".chatComposer");
  composer.parentElement.insertBefore(bar, composer);
  bar.querySelector("#msgSearchInput").addEventListener("input", (e) => {
    doMsgSearch(e.target.value.trim());
  });
  bar.querySelector("#searchPrev").addEventListener("click", () => navigateSearch(-1));
  bar.querySelector("#searchNext").addEventListener("click", () => navigateSearch(1));
  bar.querySelector("#closeSearch").addEventListener("click", hideMsgSearchBar);
  bar.querySelector("#msgSearchInput").focus();
}

function hideMsgSearchBar() {
  msgSearchVisible = false;
  const bar = $("msgSearchBar");
  if (bar) bar.remove();
  // Clear highlights
  document.querySelectorAll(".searchHighlight").forEach(el => {
    el.classList.remove("searchHighlight", "searchHighlightActive");
  });
  searchMatches = []; searchResultIdx = 0;
}

function doMsgSearch(query) {
  // Clear old highlights
  document.querySelectorAll(".searchHighlight").forEach(el => {
    el.classList.remove("searchHighlight", "searchHighlightActive");
  });
  searchMatches = []; searchResultIdx = 0;
  if (!query) { updateSearchCount(); return; }

  const q = query.toLowerCase();
  document.querySelectorAll(".bubbleText").forEach(el => {
    const text = el.textContent.toLowerCase();
    if (text.includes(q)) {
      el.classList.add("searchHighlight");
      searchMatches.push(el);
    }
  });
  updateSearchCount();
  if (searchMatches.length > 0) {
    searchResultIdx = 0;
    searchMatches[0].classList.add("searchHighlightActive");
    searchMatches[0].scrollIntoView({ behavior: "smooth", block: "center" });
    // Add highlight style inline if not in CSS
    searchMatches[0].style.outline = "2px solid var(--green)";
  }
}

function navigateSearch(dir) {
  if (searchMatches.length === 0) return;
  searchMatches[searchResultIdx].classList.remove("searchHighlightActive");
  searchMatches[searchResultIdx].style.outline = "";
  searchResultIdx = (searchResultIdx + dir + searchMatches.length) % searchMatches.length;
  searchMatches[searchResultIdx].classList.add("searchHighlightActive");
  searchMatches[searchResultIdx].style.outline = "2px solid var(--green)";
  searchMatches[searchResultIdx].scrollIntoView({ behavior: "smooth", block: "center" });
  updateSearchCount();
}

function updateSearchCount() {
  const el = $("searchCount");
  if (!el) return;
  el.textContent = searchMatches.length > 0 ? `${searchResultIdx + 1}/${searchMatches.length}` : "No results";
}

// ---- Persistent Emoji Reactions (via message_reactions table) ----
async function addReactionDB(messageId, emoji) {
  // First try DB; fallback to in-memory
  const { error } = await supabaseClient.from("message_reactions").upsert({
    message_id: messageId, user_id: currentUser.id, emoji,
  }, { onConflict: "message_id,user_id,emoji" });
  if (error) {
    // Table may not exist yet — fall back to in-memory
    addReaction(messageId, emoji);
    return;
  }
  addReaction(messageId, emoji); // update UI
}

async function removeReactionDB(messageId, emoji) {
  const { error } = await supabaseClient.from("message_reactions").delete()
    .eq("message_id", messageId).eq("user_id", currentUser.id).eq("emoji", emoji);
  if (error) removeReaction(messageId, emoji);
  removeReaction(messageId, emoji); // update UI
}

// ---- Build Message Element (extracted for reuse with context menu) ----
function buildMessageElement(m) {
  const mine = m.sender_id === currentUser.id;
  const senderProfile = allProfilesCache.get(m.sender_id) || { full_name: "Unknown", avatar_url: null };
  const initial = (senderProfile.full_name || "?").trim().charAt(0).toUpperCase();

  // Date divider
  const msgDate = new Date(m.created_at).toLocaleDateString();
  const frag = document.createDocumentFragment();
  if (msgDate !== lastMessageDate) {
    lastMessageDate = msgDate;
    const divider = document.createElement("div");
    divider.className = "messageTimestampDivider";
    divider.textContent = msgDate;
    frag.appendChild(divider);
  }

  const group = document.createElement("div");
  group.className = "messageBubbleGroup " + (mine ? "sent" : "received") + (m.is_pinned ? " isPinned" : "");
  group.dataset.messageId = m.id;

  // Context menu on right-click or long-press
  group.addEventListener("contextmenu", (e) => showMessageContextMenu(e, m.id));
  let pressTimer;
  group.addEventListener("touchstart", () => { pressTimer = setTimeout(() => showMessageContextMenu({ preventDefault(){}, clientX: 100, clientY: 200 }, m.id), 600); });
  group.addEventListener("touchend", () => clearTimeout(pressTimer));

  const avatar = document.createElement("div");
  avatar.className = "messageBubbleAvatar";
  avatar.title = senderProfile.full_name || "Unknown";
  avatar.style.cursor = "pointer";
  if (senderProfile.avatar_url) {
    const img = document.createElement("img");
    img.src = senderProfile.avatar_url;
    img.alt = senderProfile.full_name || "";
    avatar.appendChild(img);
  } else { avatar.textContent = initial; }
  if (!mine) avatar.addEventListener("click", () => openProfileView(m.sender_id));

  const container = document.createElement("div");
  container.className = "bubbleContainer";

  // Pin tag
  if (m.is_pinned) {
    const tag = document.createElement("span");
    tag.className = "pinnedTag";
    tag.textContent = "📌 Pinned";
    container.appendChild(tag);
  }

  // Reply quote
  if (m.reply_to_id) {
    const replyQuote = messageCache.get(m.reply_to_id);
    if (replyQuote) {
      const quoteSender = allProfilesCache.get(replyQuote.sender_id) || { full_name: "User" };
      const quote = document.createElement("div");
      quote.style.cssText = "border-left:3px solid var(--green);padding:4px 8px;margin-bottom:4px;font-size:11px;color:var(--muted);cursor:pointer;background:var(--greenSoft);border-radius:4px;";
      quote.innerHTML = `<strong>${escapeHtml(quoteSender.full_name)}</strong>: ${escapeHtml((replyQuote.body || "").slice(0, 80))}`;
      quote.addEventListener("click", () => scrollToMessage(m.reply_to_id));
      container.appendChild(quote);
    }
  }

  if (!mine) {
    const header = document.createElement("div");
    header.className = "messageBubbleHeader";
    const nameSpan = document.createElement("span");
    nameSpan.className = "messageBubbleName";
    nameSpan.textContent = senderProfile.full_name || "Unknown";
    nameSpan.style.cursor = "pointer";
    nameSpan.addEventListener("click", () => openProfileView(m.sender_id));
    const timeSpan = document.createElement("span");
    timeSpan.className = "messageBubbleTime";
    timeSpan.textContent = new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    header.appendChild(nameSpan);
    header.appendChild(timeSpan);
    container.appendChild(header);
  }

  // Message content: file, image, or text
  if (m.file_url) {
    const isImage = m.file_type && m.file_type.startsWith("image/");
    if (isImage) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "imageBubble";
      const img = document.createElement("img");
      img.src = m.file_url;
      img.alt = m.file_name || "Image";
      img.loading = "lazy";
      img.addEventListener("click", () => openLightbox(m.file_url));
      imgWrap.appendChild(img);
      container.appendChild(imgWrap);
    } else {
      const fileBubble = document.createElement("div");
      fileBubble.className = "fileBubble";
      fileBubble.addEventListener("click", () => window.open(m.file_url, "_blank"));
      const icon = getFileIcon(m.file_name || "");
      fileBubble.innerHTML = `
        <span class="fileIcon">${icon}</span>
        <div class="fileInfo">
          <div class="fileName">${escapeHtml(m.file_name || "File")}</div>
          <div class="fileSize">${m.file_size ? formatFileSize(m.file_size) : ""}</div>
        </div>
      `;
      container.appendChild(fileBubble);
    }
    // Also show caption text if any
    if (m.body && m.body !== m.file_name) {
      const cap = document.createElement("div");
      cap.className = "bubbleText";
      cap.dataset.messageId = m.id;
      cap.textContent = m.body;
      container.appendChild(cap);
    }
  } else {
    const text = document.createElement("div");
    text.className = "bubbleText";
    text.dataset.messageId = m.id;
    if (m.is_deleted) {
      text.innerHTML = '<span class="deletedMsg">This message was deleted.</span>';
    } else {
      text.textContent = m.body || "";
      if (m.edited_at) {
        const label = document.createElement("span");
        label.style.cssText = "font-size:10px;color:var(--muted);margin-left:4px;";
        label.textContent = "(edited)";
        text.appendChild(label);
      }
    }
    container.appendChild(text);
  }

  // Sent time (only for sent messages)
  if (mine) {
    const timeDiv = document.createElement("div");
    timeDiv.className = "sentTime";
    timeDiv.textContent = new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    container.appendChild(timeDiv);
  }

  // Reactions div
  const reactionsDiv = document.createElement("div");
  reactionsDiv.className = "messageReactions";
  reactionsDiv.dataset.messageId = m.id;
  // Render existing reactions from cache
  if (m.reactions) {
    Object.entries(m.reactions).forEach(([em, users]) => {
      const pill = document.createElement("button");
      pill.className = "reactionPill" + (users.includes(currentUser.id) ? " youReacted" : "");
      pill.innerHTML = `${em} <span class="reactionCount">${users.length}</span>`;
      pill.addEventListener("click", () => users.includes(currentUser.id) ? removeReactionDB(m.id, em) : addReactionDB(m.id, em));
      reactionsDiv.appendChild(pill);
    });
  }
  container.appendChild(reactionsDiv);

  // Read receipt
  if (mine) {
    const status = document.createElement("div");
    status.className = "messageStatus seen";
    status.innerHTML = `<span>✓✓</span> Seen`;
    container.appendChild(status);
  }

  if (!mine) group.appendChild(avatar);
  group.appendChild(container);
  if (mine) group.appendChild(avatar);
  frag.appendChild(group);

  return frag;
}

function getFileIcon(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  const map = { pdf: "📄", doc: "📝", docx: "📝", txt: "📃", xls: "📊", xlsx: "📊", zip: "🗜️", rar: "🗜️" };
  return map[ext] || "📎";
}

function openLightbox(url) {
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `<button class="closeBtn">✕</button><img src="${escapeHtml(url)}" />`;
  lb.querySelector(".closeBtn").addEventListener("click", () => lb.remove());
  lb.addEventListener("click", (e) => { if (e.target === lb) lb.remove(); });
  document.body.appendChild(lb);
}

// ---- Mute notifications for a chat (legacy in-memory, kept for compatibility) ----
function muteChat(chatId) { mutedChats.add(chatId); showToast("Chat muted."); }
function unmuteChat(chatId) { mutedChats.delete(chatId); showToast("Chat unmuted."); }

// ---------------------------------------------------------------------------
// Voice calls (WebRTC, app-to-app only — via the same Jitsi infra as video
// meetings, but audio-only. No real phone numbers / voicemail: that would
// need a telephony provider like Twilio, see README.)
// ---------------------------------------------------------------------------
$("btnStartCall").addEventListener("click", () => {
  if (!activeChatId) return;
  startVoiceCall(activeChatId);
});

async function startVoiceCall(roomId) {
  const { data: call, error } = await supabaseClient.from("calls").insert({
    room_id: roomId, call_type: "voice", status: "active", started_by: currentUser.id,
  }).select().single();
  if (error) { showToast(error.message); return; }
  await supabaseClient.from("call_participants").insert({ call_id: call.id, user_id: currentUser.id });
  joinVoiceCall(call.id, roomId);
}

function joinVoiceCall(callId, roomId) {
  activeCallId = callId;
  activeCallRoomId = roomId;
  const room = meetingsCache.find(m => m.id === roomId);
  const jitsiRoom = `meetandgreetvoice-${roomId}`;
  openJitsiCall({ room: jitsiRoom, title: "Voice call — " + (room?.title || ""), audioOnly: true, showCamBtn: false });
}

function startGlobalCallListener() {
  supabaseClient.channel("calls:incoming")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls" }, (payload) => {
      const call = payload.new;
      if (call.status !== "active") return;
      if (call.id === activeCallId) return;
      if (call.started_by === currentUser.id) {
        // Same account, different device started this call — offer to join it here.
        showHandoffBanner(call);
      } else {
        showIncomingCall(call);
      }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls" }, (payload) => {
      // If the caller hangs up before we accept, clear the banner.
      if (pendingIncomingCall && payload.new.id === pendingIncomingCall.id && payload.new.status === "ended") {
        hideIncomingCall();
      }
      if (pendingHandoffCall && payload.new.id === pendingHandoffCall.id && payload.new.status === "ended") {
        hideHandoffBanner();
      }
      if (payload.new.id === activeCallId && payload.new.status === "ended") {
        loadCallHistory();
      }
    })
    .subscribe();
}

// Cross-device handoff: catches the case where a call was already active
// before this tab/device connected (e.g. app just opened), as a fallback to
// the realtime INSERT handler above. Real-time gives instant detection when
// this device is already open; this poll is the catch-up path.
function startHandoffCheckLoop() {
  checkForActiveCallHandoff();
  setInterval(checkForActiveCallHandoff, 20 * 1000);
}

async function checkForActiveCallHandoff() {
  if (activeCallId) { hideHandoffBanner(); return; } // already on the call, from this device
  const { data, error } = await supabaseClient
    .from("call_participants")
    .select("call_id, left_at, calls!inner(id, room_id, status)")
    .eq("user_id", currentUser.id)
    .is("left_at", null)
    .eq("calls.status", "active");
  if (error) { console.error(error); return; }
  const row = (data || []).find(r => r.calls && !dismissedHandoffCallIds.has(r.calls.id));
  if (row) showHandoffBanner(row.calls); else hideHandoffBanner();
}

function showHandoffBanner(call) {
  pendingHandoffCall = call;
  $("handoffCallBar").classList.remove("hidden");
}

function hideHandoffBanner() {
  pendingHandoffCall = null;
  $("handoffCallBar").classList.add("hidden");
}

$("btnRejoinCall").addEventListener("click", () => {
  if (!pendingHandoffCall) return;
  const call = pendingHandoffCall;
  hideHandoffBanner();
  joinVoiceCall(call.id, call.room_id);
});

$("btnDismissHandoff").addEventListener("click", () => {
  if (pendingHandoffCall) dismissedHandoffCallIds.add(pendingHandoffCall.id);
  hideHandoffBanner();
});

function showIncomingCall(call) {
  pendingIncomingCall = call;
  const room = meetingsCache.find(m => m.id === call.room_id);
  $("incomingCallText").textContent = `Incoming voice call — ${room?.title || "Unknown"}`;
  $("incomingCallBar").classList.remove("hidden");
}

function hideIncomingCall() {
  pendingIncomingCall = null;
  $("incomingCallBar").classList.add("hidden");
}

$("btnAcceptCall").addEventListener("click", async () => {
  if (!pendingIncomingCall) return;
  const call = pendingIncomingCall;
  hideIncomingCall();
  await supabaseClient.from("call_participants").insert({ call_id: call.id, user_id: currentUser.id });
  joinVoiceCall(call.id, call.room_id);
});

$("btnDeclineCall").addEventListener("click", () => {
  hideIncomingCall();
});

async function loadCallHistory() {
  const { data, error } = await supabaseClient
    .from("calls")
    .select("*, meetings:room_id(title)")
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) { console.error(error); return; }
  renderCallHistory(data || []);
}

function renderCallHistory(calls) {
  const el = $("callHistoryList");
  if (!el) return;
  if (!calls.length) { el.innerHTML = `<div class="emptyState">No calls yet.</div>`; return; }
  el.innerHTML = calls.map(c => {
    let durLabel;
    if (c.status === "ended" && c.ended_at) {
      const durSec = Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.started_at)) / 1000));
      durLabel = `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
    } else {
      durLabel = c.status === "active" ? "in progress" : "missed";
    }
    return `<div class="listItem">
      <div>
        <div class="itemTitle">${escapeHtml(c.meetings?.title || "Voice call")}</div>
        <div class="itemMeta">${fmtDate(c.started_at)} • ${durLabel}</div>
      </div>
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Recordings (manual upload — auto-recording isn't built in yet)
// ---------------------------------------------------------------------------
async function renderRecordingsList() {
  const list = $("recordingsList");
  if (!list) return;
  list.innerHTML = `<div class="emptyState">Loading recordings…</div>`;
  const { data, error } = await supabaseClient
    .from("recordings")
    .select("*, meetings(title)")
    .order("created_at", { ascending: false });
  if (error) { list.innerHTML = `<div class="emptyState">Could not load recordings: ${escapeHtml(error.message)}</div>`; return; }
  if (!data || !data.length) {
    list.innerHTML = `<div class="emptyState">No recordings yet. Upload a video file above after your meeting ends.</div>`;
    return;
  }
  list.innerHTML = data.map(r => `
    <div class="listItem" data-recid="${r.id}">
      <div style="min-width:0">
        <div class="itemTitle">🎥 ${escapeHtml(r.meetings?.title || "Untitled meeting")}</div>
        <div class="itemMeta">${fmtDate(r.created_at)} • ${formatFileSize(r.file_size || 0)}</div>
      </div>
      <div style="display:flex;gap:6px;flex:0 0 auto">
        <button class="btn btnGhost btnSm" data-play="${r.id}">▶ Play</button>
        ${r.uploader_id === currentUser.id ? `<button class="btn btnDanger btnSm" data-delrec="${r.id}">🗑</button>` : ""}
      </div>
    </div>`).join("");
  list.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => playRecording(b.dataset.play, data)));
  list.querySelectorAll("[data-delrec]").forEach(b => b.addEventListener("click", () => deleteRecording(b.dataset.delrec, data)));
}

async function playRecording(id, data) {
  const rec = data.find(r => r.id === id);
  if (!rec) return;
  const { data: signed, error } = await supabaseClient.storage.from("meeting-recordings").createSignedUrl(rec.file_path, 3600);
  if (error) { showToast("Could not open recording: " + error.message); return; }
  openModal(`
    <div class="modalTitle">${escapeHtml(rec.meetings?.title || "Recording")}</div>
    <video src="${signed.signedUrl}" controls autoplay style="width:100%;border-radius:12px;background:#000;display:block"></video>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btnGhost" id="modalCancel">Close</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
}

async function deleteRecording(id, data) {
  const rec = data.find(r => r.id === id);
  if (!rec) return;
  if (!confirm("Delete this recording? This cannot be undone.")) return;
  await supabaseClient.storage.from("meeting-recordings").remove([rec.file_path]);
  const { error } = await supabaseClient.from("recordings").delete().eq("id", id);
  if (error) { showToast("Could not delete: " + error.message); return; }
  showToast("Recording deleted.");
  renderRecordingsList();
}

$("btnUploadRecording")?.addEventListener("click", () => {
  const options = meetingsCache.map(m => `<option value="${m.id}">${escapeHtml(m.title || "Untitled meeting")} — ${fmtDate(m.scheduled_at)}</option>`).join("");
  openModal(`
    <div class="modalTitle">Upload a recording</div>
    <div class="itemMeta" style="margin-bottom:12px">Recorded the meeting yourself (screen recorder, OBS, phone)? Upload the video file here to save it for everyone in that meeting.</div>
    <div class="field"><label>Meeting</label><select id="recMeetingSelect">${options || "<option value=''>No meetings yet</option>"}</select></div>
    <div class="field"><label>Video file</label><input type="file" id="recFileInput" accept="video/*" /></div>
    <button class="btn btnPrimary btnBlock" id="btnDoUploadRecording">Upload</button>
    <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn btnGhost" id="modalCancel">Cancel</button></div>
  `);
  $("modalCancel").addEventListener("click", closeModal);
  $("btnDoUploadRecording").addEventListener("click", async () => {
    const roomId = $("recMeetingSelect").value;
    const file = $("recFileInput").files[0];
    if (!roomId) { showToast("Pick a meeting first."); return; }
    if (!file) { showToast("Choose a video file first."); return; }
    if (file.size > 500 * 1024 * 1024) { showToast("File is too large (max 500MB)."); return; }
    const btn = $("btnDoUploadRecording");
    btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const ext = file.name.split(".").pop();
      const path = `${roomId}/${Date.now()}_${currentUser.id}.${ext}`;
      const { error: upErr } = await supabaseClient.storage.from("meeting-recordings").upload(path, file);
      if (upErr) throw upErr;
      const { error: insErr } = await supabaseClient.from("recordings").insert({
        room_id: roomId, uploader_id: currentUser.id, file_path: path,
        file_name: file.name, file_size: file.size, mime_type: file.type,
      });
      if (insErr) throw insErr;
      closeModal();
      showToast("Recording uploaded.");
      renderRecordingsList();
    } catch (err) {
      showToast("Upload failed: " + err.message);
      btn.disabled = false; btn.textContent = "Upload";
    }
  });
});

// ---------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------
function openModal(html) {
  $("modalCard").innerHTML = html;
  $("modalOverlay").classList.remove("hidden");
}
function closeModal() { $("modalOverlay").classList.add("hidden"); }
$("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });

// ---------------------------------------------------------------------------
// Whiteboard (per-meeting, real-time shared: freehand strokes + sticky notes)
// ---------------------------------------------------------------------------
let wbRoomId = null;
let wbChannel = null;
let wbElements = new Map(); // id -> element row
let wbColor = "#0f2419";
let wbDrawing = false;
let wbCurrentPoints = [];
let wbStickyDrag = null; // { id, offsetX, offsetY }
const wbCanvas = $("wbCanvas");
const wbCtx = wbCanvas.getContext("2d");
const wbWrap = $("wbCanvasWrap");

function renderWhiteboardPicker() {
  const boardable = meetingsCache.filter(m => m.status !== "chat");
  const list = $("wbMeetingPickerList");
  if (!boardable.length) {
    list.innerHTML = `<div class="emptyState">No meetings yet — schedule one first.</div>`;
    return;
  }
  list.innerHTML = boardable.map(m => `
    <div class="listItem" data-id="${m.id}">
      <div>
        <div class="itemTitle">${escapeHtml(m.title || "Untitled meeting")}</div>
        <div class="itemMeta">${fmtDate(m.scheduled_at)}</div>
      </div>
      <button class="btn btnPrimary btnSm" data-wbopen="${m.id}">Open board</button>
    </div>`).join("");
  list.querySelectorAll("[data-wbopen]").forEach(b => {
    b.addEventListener("click", () => openWhiteboard(b.dataset.wbopen));
  });
}

async function openWhiteboard(meetingId) {
  const meeting = meetingsCache.find(m => m.id === meetingId);
  wbRoomId = meetingId;
  $("wbMeetingLabel").textContent = "Whiteboard — " + (meeting ? meeting.title : "Meeting");
  $("wbPickerCard").classList.add("hidden");
  $("wbBoardCard").classList.remove("hidden");
  resizeWbCanvas();
  await loadWhiteboardElements();
  subscribeWhiteboard();
}

function backToWhiteboardPicker() {
  if (wbChannel) { supabaseClient.removeChannel(wbChannel); wbChannel = null; }
  wbRoomId = null;
  wbElements.clear();
  document.querySelectorAll(".stickyNote").forEach(n => n.remove());
  $("wbBoardCard").classList.add("hidden");
  $("wbPickerCard").classList.remove("hidden");
  renderWhiteboardPicker();
}
$("wbBack").addEventListener("click", backToWhiteboardPicker);

function resizeWbCanvas() {
  const rect = wbWrap.getBoundingClientRect();
  wbCanvas.width = rect.width * devicePixelRatio;
  wbCanvas.height = rect.height * devicePixelRatio;
  wbCtx.scale(devicePixelRatio, devicePixelRatio);
  wbCtx.lineCap = "round";
  wbCtx.lineJoin = "round";
  redrawWbCanvas();
}
window.addEventListener("resize", () => { if (wbRoomId) resizeWbCanvas(); });

async function loadWhiteboardElements() {
  const { data, error } = await supabaseClient.from("whiteboard_elements").select("*").eq("room_id", wbRoomId).order("created_at", { ascending: true });
  if (error) { showToast("Could not load whiteboard: " + error.message); return; }
  wbElements.clear();
  (data || []).forEach(el => wbElements.set(el.id, el));
  redrawWbCanvas();
  renderStickies();
}

function subscribeWhiteboard() {
  if (wbChannel) { supabaseClient.removeChannel(wbChannel); wbChannel = null; }
  wbChannel = supabaseClient
    .channel(`wb-${wbRoomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "whiteboard_elements", filter: `room_id=eq.${wbRoomId}` }, (payload) => {
      if (payload.eventType === "DELETE") {
        wbElements.delete(payload.old.id);
      } else {
        wbElements.set(payload.new.id, payload.new);
      }
      redrawWbCanvas();
      renderStickies();
    })
    .subscribe();
}

function redrawWbCanvas() {
  const w = wbWrap.clientWidth, h = wbWrap.clientHeight;
  wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
  for (const el of wbElements.values()) {
    if (el.type !== "stroke") continue;
    const pts = el.data.points || [];
    if (pts.length < 2) continue;
    wbCtx.strokeStyle = el.data.color || "#0f2419";
    wbCtx.lineWidth = el.data.width || 3;
    wbCtx.beginPath();
    wbCtx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) wbCtx.lineTo(pts[i].x * w, pts[i].y * h);
    wbCtx.stroke();
  }
}

function renderStickies() {
  const w = wbWrap.clientWidth, h = wbWrap.clientHeight;
  const seen = new Set();
  for (const el of wbElements.values()) {
    if (el.type !== "sticky") continue;
    seen.add(el.id);
    let node = wbWrap.querySelector(`.stickyNote[data-id="${el.id}"]`);
    if (!node) node = createStickyNode(el.id);
    if (wbStickyDrag && wbStickyDrag.id === el.id) continue; // don't fight the user's own live drag
    node.style.left = (el.data.x * w) + "px";
    node.style.top = (el.data.y * h) + "px";
    node.style.width = Math.max(120, el.data.w * w) + "px";
    node.style.height = Math.max(90, el.data.h * h) + "px";
    node.style.background = el.data.color || "#fff7cc";
    const ta = node.querySelector("textarea");
    if (document.activeElement !== ta) ta.value = el.data.text || "";
  }
  wbWrap.querySelectorAll(".stickyNote").forEach(node => {
    if (!seen.has(node.dataset.id)) node.remove();
  });
}

function createStickyNode(id) {
  const node = document.createElement("div");
  node.className = "stickyNote";
  node.dataset.id = id;
  node.innerHTML = `
    <div class="stickyHandle">
      <span>note</span>
      <span class="stickyDelete" title="Delete note">&times;</span>
    </div>
    <textarea placeholder="Type here…"></textarea>`;
  wbWrap.appendChild(node);

  const handle = node.querySelector(".stickyHandle");
  const ta = node.querySelector("textarea");
  const delBtn = node.querySelector(".stickyDelete");

  handle.addEventListener("pointerdown", (e) => {
    const rect = node.getBoundingClientRect();
    wbStickyDrag = { id, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!wbStickyDrag || wbStickyDrag.id !== id) return;
    const wrapRect = wbWrap.getBoundingClientRect();
    const x = e.clientX - wrapRect.left - wbStickyDrag.offsetX;
    const y = e.clientY - wrapRect.top - wbStickyDrag.offsetY;
    node.style.left = x + "px";
    node.style.top = y + "px";
  });
  window.addEventListener("pointerup", async () => {
    if (!wbStickyDrag || wbStickyDrag.id !== id) return;
    wbStickyDrag = null;
    const w = wbWrap.clientWidth, h = wbWrap.clientHeight;
    const el = wbElements.get(id);
    if (!el) return;
    const newData = { ...el.data, x: node.offsetLeft / w, y: node.offsetTop / h };
    el.data = newData;
    await supabaseClient.from("whiteboard_elements").update({ data: newData, updated_at: new Date().toISOString() }).eq("id", id);
  });

  let taTimer = null;
  ta.addEventListener("input", () => {
    clearTimeout(taTimer);
    taTimer = setTimeout(async () => {
      const el = wbElements.get(id);
      if (!el) return;
      const newData = { ...el.data, text: ta.value };
      el.data = newData;
      await supabaseClient.from("whiteboard_elements").update({ data: newData, updated_at: new Date().toISOString() }).eq("id", id);
    }, 500);
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const w = wbWrap.clientWidth, h = wbWrap.clientHeight;
      const el = wbElements.get(id);
      if (!el) return;
      const newData = { ...el.data, w: node.clientWidth / w, h: node.clientHeight / h };
      el.data = newData;
      await supabaseClient.from("whiteboard_elements").update({ data: newData, updated_at: new Date().toISOString() }).eq("id", id);
    }, 500);
  }).observe(node);

  delBtn.addEventListener("click", async () => {
    node.remove();
    wbElements.delete(id);
    await supabaseClient.from("whiteboard_elements").delete().eq("id", id);
  });

  return node;
}

$("wbAddSticky").addEventListener("click", async () => {
  if (!wbRoomId) return;
  const data = { x: 0.35, y: 0.3, w: 0.18, h: 0.14, text: "", color: "#fff7cc" };
  const { data: inserted, error } = await supabaseClient.from("whiteboard_elements").insert({
    room_id: wbRoomId, type: "sticky", data, created_by: currentUser.id,
  }).select().single();
  if (error) { showToast("Could not add sticky note: " + error.message); return; }
  wbElements.set(inserted.id, inserted);
  renderStickies();
});

$("wbClear").addEventListener("click", async () => {
  if (!wbRoomId) return;
  if (!confirm("Clear the whole board for everyone in this meeting?")) return;
  const { error } = await supabaseClient.from("whiteboard_elements").delete().eq("room_id", wbRoomId);
  if (error) { showToast("Could not clear board: " + error.message); return; }
  wbElements.clear();
  document.querySelectorAll(".stickyNote").forEach(n => n.remove());
  redrawWbCanvas();
});

document.querySelectorAll(".wbColorBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    wbColor = btn.dataset.color;
    document.querySelectorAll(".wbColorBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

function wbPos(e) {
  const rect = wbWrap.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { x: (t.clientX - rect.left), y: (t.clientY - rect.top) };
}
function wbStart(e) {
  if (!wbRoomId || e.target !== wbCanvas) return;
  wbDrawing = true;
  const p = wbPos(e);
  wbCurrentPoints = [p];
  wbCtx.beginPath();
  wbCtx.strokeStyle = wbColor;
  wbCtx.lineWidth = 3;
  wbCtx.moveTo(p.x, p.y);
}
function wbMove(e) {
  if (!wbDrawing) return;
  const p = wbPos(e);
  wbCurrentPoints.push(p);
  wbCtx.lineTo(p.x, p.y);
  wbCtx.stroke();
  e.preventDefault();
}
async function wbEnd() {
  if (!wbDrawing) return;
  wbDrawing = false;
  if (wbCurrentPoints.length < 2) { wbCurrentPoints = []; return; }
  const w = wbWrap.clientWidth, h = wbWrap.clientHeight;
  const normPoints = wbCurrentPoints.map(p => ({ x: p.x / w, y: p.y / h }));
  wbCurrentPoints = [];
  const data = { points: normPoints, color: wbColor, width: 3 };
  const { data: inserted, error } = await supabaseClient.from("whiteboard_elements").insert({
    room_id: wbRoomId, type: "stroke", data, created_by: currentUser.id,
  }).select().single();
  if (error) { showToast("Could not save drawing: " + error.message); return; }
  wbElements.set(inserted.id, inserted);
}
wbCanvas.addEventListener("mousedown", wbStart);
window.addEventListener("mousemove", wbMove);
window.addEventListener("mouseup", wbEnd);
wbCanvas.addEventListener("touchstart", wbStart);
wbCanvas.addEventListener("touchmove", wbMove);
wbCanvas.addEventListener("touchend", wbEnd);


/* ============================================================
   MORE: Feed / Marketplace / Forum
   Requires 3 Supabase tables — see supabase_more_tables.sql
   ============================================================ */

document.getElementById("moreSubTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".subTabBtn");
  if (!btn) return;
  document.querySelectorAll("#moreSubTabs .subTabBtn").forEach(b => b.classList.toggle("active", b === btn));
  document.querySelectorAll("#viewMore .subView").forEach(v => v.classList.remove("active"));
  $("more" + btn.dataset.sub.charAt(0).toUpperCase() + btn.dataset.sub.slice(1)).classList.add("active");
});

/* ---------- FEED (read-only announcements) ---------- */
async function loadFeed() {
  const { data, error } = await supabaseClient.from("feed_posts").select("*").order("created_at", { ascending: false }).limit(30);
  const targets = [$("feedList"), $("dashFeedList")].filter(Boolean);
  if (error) {
    console.error("loadFeed:", error);
    targets.forEach(list => list.innerHTML = `<div class="emptyState">Could not load feed.</div>`);
    return;
  }
  if (!data || !data.length) {
    targets.forEach(list => list.innerHTML = `<div class="emptyState">No announcements yet — check back soon.</div>`);
    return;
  }
  const html = data.map(p => `
    <div class="feedCard">
      <div class="feedMeta">${fmtDate(p.created_at)}${p.author_name ? " • " + escapeHtml(p.author_name) : ""}</div>
      <div class="feedTitle">${escapeHtml(p.title || "")}</div>
      <div class="feedBody">${escapeHtml(p.body || "")}</div>
    </div>
  `).join("");
  // Dashboard shows a shorter preview (first 5); Community shows the full feed.
  targets.forEach(list => { list.innerHTML = list.id === "dashFeedList" ? data.slice(0, 5).map(p => `
    <div class="feedCard">
      <div class="feedMeta">${fmtDate(p.created_at)}${p.author_name ? " • " + escapeHtml(p.author_name) : ""}</div>
      <div class="feedTitle">${escapeHtml(p.title || "")}</div>
      <div class="feedBody">${escapeHtml(p.body || "")}</div>
    </div>
  `).join("") : html; });
}

/* ---------- MARKETPLACE (job listings) ---------- */
async function loadJobs() {
  const list = $("jobList");
  const { data, error } = await supabaseClient.from("job_listings").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) { console.error("loadJobs:", error); list.innerHTML = `<div class="emptyState">Could not load listings.</div>`; return; }
  const visible = (data || []).filter(j => !j.flagged || j.poster_id === currentUser?.id);
  if (!visible.length) { list.innerHTML = `<div class="emptyState">No job listings yet — be the first to post one.</div>`; return; }
  list.innerHTML = visible.map(j => `
    <div class="jobCard">
      <div class="jobTop">
        <div class="jobTitle">${escapeHtml(j.title || "")}${j.flagged ? ` <span class="badge badgeFree" style="color:var(--danger)">Under review</span>` : ""}</div>
        ${j.budget ? `<div class="jobBudget">${escapeHtml(j.budget)}</div>` : ""}
      </div>
      <div class="jobDesc">${escapeHtml(j.description || "")}</div>
      <div class="jobFoot">
        <span class="jobPoster">Posted by ${escapeHtml(j.poster_name || "Someone")}</span>
        <button class="btn btnGhost btnSm" data-apply-job="${j.id}">Apply</button>
      </div>
    </div>
  `).join("");
  list.querySelectorAll("[data-apply-job]").forEach(btn => {
    btn.addEventListener("click", () => applyToJob(btn.dataset.applyJob));
  });
}

async function applyToJob(jobId) {
  if (!currentUser) { showToast("Please log in first."); return; }
  const { error } = await supabaseClient.from("job_applications").insert({
    job_id: jobId, applicant_id: currentUser.id, applicant_name: currentProfile?.full_name || "Guest",
  });
  if (error) { showToast("Could not apply: " + error.message); return; }
  showToast("Application sent!");
}

$("btnPostJob").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Post a job</div>
    <div class="field"><label>Title</label><input type="text" id="jobTitleInput" placeholder="e.g. Video editor needed" /></div>
    <div class="field"><label>Budget (optional)</label><input type="text" id="jobBudgetInput" placeholder="e.g. ₱5,000" /></div>
    <div class="field"><label>Description</label><textarea id="jobDescInput" rows="4" placeholder="Describe the job…"></textarea></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn btnGhost" id="jobPostCancel">Cancel</button>
      <button class="btn btnPrimary" id="jobPostSubmit">Post</button>
    </div>
  `);
  $("jobPostCancel").addEventListener("click", closeModal);
  $("jobPostSubmit").addEventListener("click", async () => {
    const title = $("jobTitleInput").value.trim();
    const budget = $("jobBudgetInput").value.trim();
    const description = $("jobDescInput").value.trim();
    if (!title || !description) { showToast("Please fill in title and description."); return; }
    const mod = moderateText(title + " " + description);
    const { error } = await supabaseClient.from("job_listings").insert({
      title, budget: budget || null, description,
      poster_id: currentUser?.id || null, poster_name: currentProfile?.full_name || "Guest",
      flagged: mod.flagged, flag_reason: mod.reason,
    });
    if (error) { showToast("Could not post job: " + error.message); return; }
    closeModal();
    showToast(mod.flagged ? "Posted — pending review (contains restricted content)." : "Job posted!");
    loadJobs();
  });
});

/* ---------- FORUM (discussions) ---------- */
/* ---------- Auto-moderation (scam / spam detection) ---------- */
const MODERATION_BLOCKLIST = [
  // scam / financial-fraud patterns
  "send money first", "gcash mo muna", "advance payment bago", "investment guaranteed",
  "double your money", "sigurado kikita", "click this link to claim", "claim your prize",
  "free load promo", "verify your account here", "bit.ly", "tinyurl.com",
  // contact-info harvesting / off-platform redirect (common scam funnel)
  "add me sa telegram", "message me sa whatsapp", "text lang sa number",
];

function moderateText(text) {
  const lower = (text || "").toLowerCase();
  const hit = MODERATION_BLOCKLIST.find(k => lower.includes(k));
  return { flagged: !!hit, reason: hit || null };
}

async function loadForum() {
  const list = $("forumList");
  const { data, error } = await supabaseClient.from("forum_posts").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) { console.error("loadForum:", error); list.innerHTML = `<div class="emptyState">Could not load discussions.</div>`; return; }
  if (!data || !data.length) { list.innerHTML = `<div class="emptyState">No discussions yet — start one.</div>`; return; }
  const visible = data.filter(f => !f.flagged || f.author_id === currentUser?.id);
  if (!visible.length) { list.innerHTML = `<div class="emptyState">No discussions yet — start one.</div>`; return; }
  list.innerHTML = visible.map(f => `
    <div class="forumCard" data-thread="${f.id}">
      <div class="forumTitle">${escapeHtml(f.title || "")}${f.flagged ? ` <span class="badge badgeFree" style="color:var(--danger)">Under review</span>` : ""}</div>
      <div class="forumMeta"><span>${escapeHtml(f.author_name || "Guest")}</span><span>${fmtDate(f.created_at)}</span><span>${f.reply_count || 0} replies</span></div>
    </div>
  `).join("");
  list.querySelectorAll("[data-thread]").forEach(card => {
    card.addEventListener("click", () => openTextModal("Discussion", `<p>${escapeHtml(card.querySelector(".forumTitle").textContent)}</p><p class="itemMeta">Full thread view coming soon.</p>`));
  });
}

$("btnNewThread").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Start a discussion</div>
    <div class="field"><label>Title</label><input type="text" id="threadTitleInput" placeholder="What do you want to discuss?" /></div>
    <div class="field"><label>Message</label><textarea id="threadBodyInput" rows="4" placeholder="Say more…"></textarea></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn btnGhost" id="threadPostCancel">Cancel</button>
      <button class="btn btnPrimary" id="threadPostSubmit">Post</button>
    </div>
  `);
  $("threadPostCancel").addEventListener("click", closeModal);
  $("threadPostSubmit").addEventListener("click", async () => {
    const title = $("threadTitleInput").value.trim();
    const body = $("threadBodyInput").value.trim();
    if (!title) { showToast("Please add a title."); return; }
    const mod = moderateText(title + " " + body);
    const { error } = await supabaseClient.from("forum_posts").insert({
      title, body, author_id: currentUser?.id || null, author_name: currentProfile?.full_name || "Guest",
      reply_count: 0, flagged: mod.flagged, flag_reason: mod.reason,
    });
    if (error) { showToast("Could not post: " + error.message); return; }
    closeModal();
    showToast(mod.flagged ? "Posted — pending review (contains restricted content)." : "Discussion posted!");
    loadForum();
  });
});

/* ============================================================
   TWO-FACTOR AUTHENTICATION (TOTP via Supabase Auth MFA)
   ============================================================ */
$("btnTwoFactor").addEventListener("click", async () => {
  const { data: factorsData, error: factorsErr } = await supabaseClient.auth.mfa.listFactors();
  if (factorsErr) { showToast("Could not check 2FA status: " + factorsErr.message); return; }
  const verified = (factorsData?.totp || []).find(f => f.status === "verified");

  if (verified) {
    openModal(`
      <div class="modalTitle">Two-factor authentication</div>
      <div class="itemMeta" style="margin-bottom:14px">Two-factor authentication is <strong style="color:var(--greenDeep)">enabled</strong> on your account using an authenticator app.</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btnGhost" id="twofaClose">Close</button>
        <button class="btn btnDanger" id="twofaDisable">Turn off 2FA</button>
      </div>
    `);
    $("twofaClose").addEventListener("click", closeModal);
    $("twofaDisable").addEventListener("click", async () => {
      const { error } = await supabaseClient.auth.mfa.unenroll({ factorId: verified.id });
      if (error) { showToast("Could not disable 2FA: " + error.message); return; }
      closeModal();
      showToast("Two-factor authentication turned off.");
    });
    return;
  }

  // Not enrolled yet — start enrollment
  const { data: enrollData, error: enrollErr } = await supabaseClient.auth.mfa.enroll({ factorType: "totp" });
  if (enrollErr) { showToast("Could not start 2FA setup: " + enrollErr.message); return; }
  const factorId = enrollData.id;
  const qrSvg = enrollData.totp.qr_code;
  const secret = enrollData.totp.secret;

  openModal(`
    <div class="modalTitle">Set up two-factor authentication</div>
    <div class="itemMeta" style="margin-bottom:10px">Scan this QR code with an authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code it shows.</div>
    <div style="display:flex;justify-content:center;margin-bottom:10px">${qrSvg}</div>
    <div class="itemMeta" style="margin-bottom:14px;text-align:center">Or enter manually: <code>${escapeHtml(secret)}</code></div>
    <div class="field"><label>6-digit code</label><input type="text" id="twofaCodeInput" maxlength="6" placeholder="123456" /></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn btnGhost" id="twofaCancel">Cancel</button>
      <button class="btn btnPrimary" id="twofaVerify">Verify & enable</button>
    </div>
  `);
  $("twofaCancel").addEventListener("click", async () => {
    await supabaseClient.auth.mfa.unenroll({ factorId });
    closeModal();
  });
  $("twofaVerify").addEventListener("click", async () => {
    const code = $("twofaCodeInput").value.trim();
    if (!/^\d{6}$/.test(code)) { showToast("Enter the 6-digit code from your app."); return; }
    const { data: challengeData, error: challengeErr } = await supabaseClient.auth.mfa.challenge({ factorId });
    if (challengeErr) { showToast("Error: " + challengeErr.message); return; }
    const { error: verifyErr } = await supabaseClient.auth.mfa.verify({ factorId, challengeId: challengeData.id, code });
    if (verifyErr) { showToast("Incorrect code, try again."); return; }
    closeModal();
    showToast("Two-factor authentication enabled!");
  });
});

/* ============================================================
   COMMUNITY STATS (members, posts, online now, newest members)
   Requires: profiles.last_seen_at column (see supabase_more_tables.sql)
   "Online now" = profile updated its heartbeat in the last 5 minutes —
   an honest approximation, not full real-time presence tracking.
   ============================================================ */
async function loadCommunityStats() {
  const [{ count: memberCount }, { count: forumCount }, { count: jobCount }, { count: onlineCount }, { data: newest }] = await Promise.all([
    supabaseClient.from("profiles").select("*", { count: "exact", head: true }),
    supabaseClient.from("forum_posts").select("*", { count: "exact", head: true }),
    supabaseClient.from("job_listings").select("*", { count: "exact", head: true }),
    supabaseClient.from("profiles").select("*", { count: "exact", head: true }).gte("last_seen_at", new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    supabaseClient.from("profiles").select("id, full_name, created_at").order("created_at", { ascending: false }).limit(5),
  ]);

  $("statMembers").textContent = memberCount ?? "–";
  $("statPosts").textContent = ((forumCount || 0) + (jobCount || 0)) || "–";
  $("statOnline").textContent = onlineCount ?? "–";

  const list = $("newestMembersList");
  if (!newest || !newest.length) { list.innerHTML = `<div class="emptyState">No members yet.</div>`; return; }
  list.innerHTML = newest.map(m => `
    <div class="listItem">
      <div class="itemMeta">${escapeHtml(m.full_name || "New member")} — joined ${fmtDate(m.created_at)}</div>
    </div>
  `).join("");
}

/* Heartbeat: update our own last_seen_at every 60s while the app is open,
   so "Online now" reflects reality rather than being hardcoded. */
let heartbeatInterval = null;
function startPresenceHeartbeat() {
  if (heartbeatInterval || !currentUser) return;
  const beat = () => supabaseClient.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", currentUser.id);
  beat();
  heartbeatInterval = setInterval(beat, 60000);
}

/* ---------- Active Status Bar: online friends (real presence via last_seen_at) ---------- */
async function renderActiveStatusBar() {
  const el = $("activeStatusBar");
  if (!el || !currentUser) return;
  const { data: follows } = await supabaseClient.from("follows").select("followee_id").eq("follower_id", currentUser.id);
  const followingIds = (follows || []).map(f => f.followee_id);
  if (!followingIds.length) { el.innerHTML = ""; return; }

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: online } = await supabaseClient.from("profiles").select("id, full_name, last_seen_at").in("id", followingIds).gte("last_seen_at", fiveMinAgo);
  if (!online || !online.length) { el.innerHTML = ""; return; }

  el.innerHTML = online.map(p => {
    const initial = (p.full_name || "?").trim().charAt(0).toUpperCase();
    return `
      <div class="activeStatusItem" data-user="${p.id}">
        <div class="activeStatusAvatar">${escapeHtml(initial)}<span class="activeStatusDot"></span></div>
        <div class="activeStatusName">${escapeHtml((p.full_name || "").split(" ")[0] || "Friend")}</div>
      </div>`;
  }).join("");
}

/* ---------- Global search (top bar 🔎) ---------- */
$("btnGlobalSearch").addEventListener("click", () => {
  openModal(`
    <div class="modalTitle">Search</div>
    <div class="field"><input type="text" id="globalSearchInput" placeholder="Search people, forum posts, jobs…" /></div>
    <div class="list" id="globalSearchResults" style="margin-top:10px"><div class="emptyState">Type to search.</div></div>
  `);
  const input = $("globalSearchInput");
  input.focus();
  input.addEventListener("input", debounce(async () => {
    const q = input.value.trim();
    const results = $("globalSearchResults");
    if (q.length < 2) { results.innerHTML = `<div class="emptyState">Type at least 2 characters.</div>`; return; }
    const [{ data: people }, { data: forum }, { data: jobs }] = await Promise.all([
      supabaseClient.from("profiles").select("id, full_name").ilike("full_name", `%${q}%`).limit(5),
      supabaseClient.from("forum_posts").select("id, title").ilike("title", `%${q}%`).limit(5),
      supabaseClient.from("job_listings").select("id, title").ilike("title", `%${q}%`).limit(5),
    ]);
    const sections = [];
    if (people?.length) sections.push(`<div class="itemMeta" style="margin:8px 0 4px">People</div>` + people.map(p => `<div class="listItem">${escapeHtml(p.full_name || "—")}</div>`).join(""));
    if (forum?.length) sections.push(`<div class="itemMeta" style="margin:8px 0 4px">Forum</div>` + forum.map(f => `<div class="listItem">${escapeHtml(f.title)}</div>`).join(""));
    if (jobs?.length) sections.push(`<div class="itemMeta" style="margin:8px 0 4px">Marketplace</div>` + jobs.map(j => `<div class="listItem">${escapeHtml(j.title)}</div>`).join(""));
    results.innerHTML = sections.length ? sections.join("") : `<div class="emptyState">No results for "${escapeHtml(q)}".</div>`;
  }, 350));
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
