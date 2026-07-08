const STORAGE_BUCKET = 'submission-images';
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const STUDENT_UPLOAD_TYPES = ['image/', 'application/pdf'];
const TEACHER_UPLOAD_TYPES = ['image/', 'application/pdf'];

const state = {
  client: null,
  sessionToken: null,
  sessionExpiresAt: null,
  role: null,
  email: null,
  name: null,
  grade: null,
  tasks: [],
  submissions: [],
  approvedStudents: [],
  selectedTaskId: null,
  editingTaskId: null,
  teacherSubmissions: [],
};

const $ = (id) => document.getElementById(id);
const screens = ['configScreen', 'loginScreen', 'blockedScreen', 'studentScreen', 'teacherScreen'];

function hideAllScreens() {
  screens.forEach((id) => $(id)?.classList.add('hidden'));
}

function showScreen(id) {
  hideAllScreens();
  $(id)?.classList.remove('hidden');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normaliseEmail(email = '') {
  return email.trim().toLowerCase();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').trim();
}

function formatDateTime(value) {
  if (!value) return 'No due date/time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function formatSubmittedDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function toDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#7f1d1d' : '#064e3b';
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 4600);
}

function isConfigReady() {
  return Boolean(
    window.SNT_SUPABASE_URL &&
    window.SNT_SUPABASE_ANON_KEY &&
    !String(window.SNT_SUPABASE_URL).includes('YOUR-PROJECT') &&
    !String(window.SNT_SUPABASE_ANON_KEY).includes('YOUR_')
  );
}

function setBusy(button, busyText = 'Working...') {
  if (!button) return () => {};
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  return () => {
    button.disabled = false;
    button.textContent = oldText;
  };
}

function isAllowedFile(file, allowedPrefixes = STUDENT_UPLOAD_TYPES) {
  return allowedPrefixes.some((prefix) => file.type === prefix || file.type.startsWith(prefix));
}

function isImagePath(path = '') {
  return /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(path);
}

function isPdfPath(path = '') {
  return /\.pdf$/i.test(path);
}

function fileLabelFromPath(path = '') {
  return decodeURIComponent(String(path).split('/').pop() || 'file');
}

function safeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'file';
}

async function init() {
  bindStaticEvents();

  if (!isConfigReady()) {
    showScreen('configScreen');
    return;
  }

  state.client = window.supabase.createClient(
    window.SNT_SUPABASE_URL,
    window.SNT_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );

  await restoreSession();
}

function bindStaticEvents() {
  $('loginForm')?.addEventListener('submit', handleLogin);
  $('logoutBtn')?.addEventListener('click', handleLogout);
  $('refreshStudentBtn')?.addEventListener('click', loadStudentView);
  $('refreshTeacherBtn')?.addEventListener('click', loadTeacherView);
  $('studentSearch')?.addEventListener('input', renderStudentTasksList);
  $('studentStatusFilter')?.addEventListener('change', renderStudentTasksList);
  $('taskForm')?.addEventListener('submit', handleSaveTask);
  $('cancelTaskEditBtn')?.addEventListener('click', resetTaskForm);
  $('taskFileInput')?.addEventListener('change', (event) => handleFilePreview(event, 'taskFilePreview'));
  $('studentApprovalForm')?.addEventListener('submit', handleApproveStudent);

  ['submissionTaskFilter', 'submissionStudentFilter', 'submissionStatusFilter'].forEach((id) => {
    $(id)?.addEventListener('change', renderTeacherSubmissions);
  });
  $('submissionStudentSearch')?.addEventListener('input', renderTeacherSubmissions);
  $('dueStudentSelect')?.addEventListener('change', renderSelectedStudentDueList);

  ['taskStudentFilter', 'taskGradeFilter'].forEach((id) => $(id)?.addEventListener('change', renderTeacherTasks));
  ['scoreGradeFilter', 'scoreStudentFilter'].forEach((id) => $(id)?.addEventListener('change', renderScoresTab));
  $('scoreSearch')?.addEventListener('input', renderScoresTab);

  $('printReviewBtn')?.addEventListener('click', () => window.print());

  document.querySelectorAll('[data-teacher-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTeacherTab(button.dataset.teacherTab));
  });
}

async function handleLogin(event) {
  event.preventDefault();
  const mode = event.submitter?.dataset?.loginMode || 'student';
  const email = normaliseEmail($('emailInput').value);
  const password = $('passwordInput').value;
  const stopBusy = setBusy(event.submitter, mode === 'teacher' ? 'Checking teacher...' : 'Checking student...');

  try {
    const { data, error } = await state.client.rpc('app_login', {
      p_email: email,
      p_password: password,
      p_role: mode,
    });
    if (error) throw error;

    const loginRow = Array.isArray(data) ? data[0] : data;
    if (!loginRow?.session_token) {
      throw new Error('Login failed. Check email and password.');
    }

    saveSession(loginRow);
    $('loginForm').reset();
    $('loginMessage').classList.add('hidden');
    showToast(mode === 'teacher' ? 'Teacher login successful.' : 'Student login successful.');
    await routeByRole();
  } catch (error) {
    $('loginMessage').textContent = error.message || 'Login failed. Check email and password.';
    $('loginMessage').classList.remove('hidden');
    showToast(error.message || 'Login failed.', true);
  } finally {
    stopBusy();
  }
}

function saveSession(sessionRow) {
  state.sessionToken = sessionRow.session_token;
  state.sessionExpiresAt = sessionRow.expires_at;
  state.role = sessionRow.role;
  state.email = normaliseEmail(sessionRow.email);
  state.name = sessionRow.name || null;
  state.grade = sessionRow.grade || null;

  window.localStorage.setItem('snt_session_token', state.sessionToken);
  window.localStorage.setItem('snt_session_role', state.role);
  window.localStorage.setItem('snt_session_email', state.email);
  window.localStorage.setItem('snt_session_name', state.name || '');
  window.localStorage.setItem('snt_session_grade', state.grade || '');
  window.localStorage.setItem('snt_session_expires_at', state.sessionExpiresAt || '');

  updateUserBadge();
}

function clearSession() {
  ['snt_session_token', 'snt_session_role', 'snt_session_email', 'snt_session_name', 'snt_session_grade', 'snt_session_expires_at'].forEach((key) => {
    window.localStorage.removeItem(key);
  });

  state.sessionToken = null;
  state.sessionExpiresAt = null;
  state.role = null;
  state.email = null;
  state.name = null;
  state.grade = null;
  state.tasks = [];
  state.submissions = [];
  state.approvedStudents = [];
  state.teacherSubmissions = [];
  state.selectedTaskId = null;
  state.editingTaskId = null;
}

function updateUserBadge() {
  if (!state.email) {
    $('userBadge')?.classList.add('hidden');
    $('logoutBtn')?.classList.add('hidden');
    return;
  }

  const roleLabel = state.role === 'teacher' ? 'Teacher' : 'Student';
  const namePart = state.name ? `${state.name} • ` : '';
  const gradePart = state.grade ? ` • ${state.grade}` : '';
  $('userBadge').textContent = `${roleLabel}: ${namePart}${state.email}${gradePart}`;
  $('userBadge').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}

async function restoreSession() {
  const token = window.localStorage.getItem('snt_session_token');
  if (!token) {
    showScreen('loginScreen');
    return;
  }

  try {
    const { data, error } = await state.client.rpc('app_session_info', {
      p_session_token: token,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.email) {
      clearSession();
      showScreen('loginScreen');
      return;
    }

    saveSession({
      session_token: token,
      role: row.role,
      email: row.email,
      name: row.name,
      grade: row.grade,
      expires_at: row.expires_at,
    });
    await routeByRole();
  } catch (error) {
    console.warn('Session restore failed:', error.message);
    clearSession();
    showScreen('loginScreen');
  }
}

async function routeByRole() {
  updateUserBadge();

  if (state.role === 'teacher') {
    showScreen('teacherScreen');
    await loadTeacherView();
    return;
  }

  if (state.role === 'student') {
    showScreen('studentScreen');
    await loadStudentView();
    return;
  }

  showScreen('loginScreen');
}

async function handleLogout() {
  if (state.client && state.sessionToken) {
    try {
      await state.client.rpc('app_logout', { p_session_token: state.sessionToken });
    } catch (error) {
      console.warn('Logout RPC failed:', error.message);
    }
  }

  clearSession();
  showScreen('loginScreen');
  updateUserBadge();
}

function requireSession(role) {
  if (!state.sessionToken || state.role !== role) {
    throw new Error('Please log in again.');
  }
}

async function loadStudentView() {
  if (state.role !== 'student' || !state.sessionToken) return;

  try {
    const [{ data: tasks, error: tasksError }, { data: submissions, error: submissionsError }] = await Promise.all([
      state.client.rpc('app_student_tasks', { p_session_token: state.sessionToken }),
      state.client.rpc('app_student_submissions', { p_session_token: state.sessionToken }),
    ]);

    if (tasksError) throw tasksError;
    if (submissionsError) throw submissionsError;

    state.tasks = tasks || [];
    state.submissions = submissions || [];
    renderStudentTasksList();

    if (state.selectedTaskId) {
      const selected = state.tasks.find((task) => task.id === state.selectedTaskId);
      if (selected) await renderStudentTaskPanel(selected);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function getSubmissionForTask(taskId) {
  return state.submissions.find((submission) => submission.task_id === taskId);
}

function getDueAt(task) {
  if (task?.due_at) return new Date(task.due_at);
  if (task?.due_date) return new Date(`${task.due_date}T23:59:00`);
  return null;
}

function isTaskOverdue(task) {
  const due = getDueAt(task);
  return due ? due.getTime() < Date.now() : false;
}

function isDueSoon(task) {
  const due = getDueAt(task);
  if (!due) return false;
  const diff = due.getTime() - Date.now();
  return diff >= 0 && diff <= 48 * 60 * 60 * 1000;
}

function renderStudentTasksList() {
  const list = $('studentTasksList');
  const query = $('studentSearch')?.value.trim().toLowerCase() || '';
  const filter = $('studentStatusFilter')?.value || 'all';

  let tasks = [...state.tasks];

  if (query) {
    tasks = tasks.filter((task) =>
      `${task.title || ''} ${task.subject || ''} ${task.grade || ''} ${task.instructions || ''}`.toLowerCase().includes(query)
    );
  }

  if (filter !== 'all') {
    tasks = tasks.filter((task) => {
      const submitted = Boolean(getSubmissionForTask(task.id));
      if (filter === 'submitted') return submitted;
      if (filter === 'open') return !submitted;
      if (filter === 'overdue') return !submitted && isTaskOverdue(task);
      if (filter === 'due_soon') return !submitted && isDueSoon(task);
      return true;
    });
  }

  if (!tasks.length) {
    list.innerHTML = '<div class="empty-state"><p>No tasks found.</p></div>';
    return;
  }

  list.innerHTML = tasks.map((task) => {
    const submission = getSubmissionForTask(task.id);
    const submitted = Boolean(submission);
    const overdue = isTaskOverdue(task) && !submitted;
    return `
      <article class="task-card ${state.selectedTaskId === task.id ? 'active' : ''}" data-task-id="${task.id}">
        <h4>${escapeHtml(task.title)}</h4>
        <p class="muted">${escapeHtml(task.subject || 'General')} ${task.grade ? '• ' + escapeHtml(task.grade) : ''}</p>
        <div class="meta-row">
          <span class="pill ${submitted ? '' : 'gray'}">${submitted ? 'Submitted' : 'Open'}</span>
          <span class="pill ${overdue ? 'danger' : 'warning'}">Due: ${escapeHtml(formatDateTime(task.due_at || task.due_date))}</span>
          ${submission?.score !== null && submission?.score !== undefined ? `<span class="pill">Score: ${escapeHtml(submission.score)}</span>` : ''}
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('[data-task-id]').forEach((card) => {
    card.addEventListener('click', async () => {
      const task = state.tasks.find((item) => item.id === card.dataset.taskId);
      if (!task) return;
      state.selectedTaskId = task.id;
      renderStudentTasksList();
      await renderStudentTaskPanel(task);
    });
  });
}

async function renderStudentTaskPanel(task) {
  const panel = $('studentTaskPanel');
  const submission = getSubmissionForTask(task.id);
  const savedAnswer = submission?.answer || '';
  const savedPaths = safeArray(submission?.image_paths);
  const taskFiles = safeArray(task.attachment_paths);
  const correctionPaths = safeArray(submission?.correction_paths);
  const savedFilesHtml = savedPaths.length
    ? `<div class="file-list" id="studentSavedFiles"><p class="muted">Loading your submitted files...</p></div>`
    : '';
  const taskFilesHtml = taskFiles.length
    ? `<div class="file-list" id="studentTaskFiles"><p class="muted">Loading task files...</p></div>`
    : '';
  const correctionFilesHtml = correctionPaths.length
    ? `<div class="file-list" id="studentCorrectionFiles"><p class="muted">Loading correction files...</p></div>`
    : '';

  panel.innerHTML = `
    <div class="task-detail">
      <div class="screen-title">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="muted">${escapeHtml(task.subject || 'General')} ${task.grade ? '• ' + escapeHtml(task.grade) : ''} • Due: ${escapeHtml(formatDateTime(task.due_at || task.due_date))}</p>
        </div>
        <span class="pill ${submission ? '' : 'gray'}">${submission ? 'Already submitted' : 'Not submitted yet'}</span>
      </div>

      <h4>Teacher instructions</h4>
      <pre class="answer-display">${escapeHtml(task.instructions || '')}</pre>
      ${task.link_url ? `<p><a href="${escapeHtml(task.link_url)}" target="_blank" rel="noopener">Open teacher link</a></p>` : ''}
      ${taskFilesHtml}

      <form id="submissionForm" class="stack">
        <input type="hidden" id="submissionExistingPaths" value="${escapeHtml(JSON.stringify(savedPaths))}" />
        <label>
          Student written answer
          <textarea id="studentAnswer" class="answer-box" placeholder="Type your answer here..." required>${escapeHtml(savedAnswer)}</textarea>
        </label>
        <label>
          Upload from files/gallery — multiple allowed
          <input id="studentFileInput" type="file" accept="image/*,application/pdf" multiple />
        </label>
        <label>
          Take photo directly from camera
          <input id="studentCameraInput" type="file" accept="image/*" capture="environment" />
        </label>
        <div id="studentFilePreview" class="preview-grid"></div>
        ${savedFilesHtml}
        ${submission ? `<p class="notice">Last submitted: ${escapeHtml(formatSubmittedDateTime(submission.submitted_at))}</p>` : ''}
        ${submission?.score !== null && submission?.score !== undefined ? `<p class="notice"><strong>Score:</strong> ${escapeHtml(submission.score)}${task.max_score ? ' / ' + escapeHtml(task.max_score) : ''}</p>` : ''}
        ${submission?.feedback ? `<p class="notice"><strong>Teacher feedback:</strong><br>${escapeHtml(submission.feedback)}</p>` : ''}
        ${correctionFilesHtml}
        <button class="btn btn-primary" type="submit">Submit task</button>
      </form>
    </div>
  `;

  $('studentFileInput').addEventListener('change', (event) => handleFilePreview(event, 'studentFilePreview'));
  $('studentCameraInput').addEventListener('change', (event) => handleFilePreview(event, 'studentFilePreview', true));
  $('submissionForm').addEventListener('submit', (event) => handleSubmitTask(event, task));

  if (taskFiles.length) {
    $('studentTaskFiles').innerHTML = await renderStoredFiles(taskFiles, 'Teacher task files');
  }
  if (savedPaths.length) {
    $('studentSavedFiles').innerHTML = await renderStoredFiles(savedPaths, 'Your submitted files');
  }
  if (correctionPaths.length) {
    $('studentCorrectionFiles').innerHTML = await renderStoredFiles(correctionPaths, 'Teacher correction files');
  }
}

function handleFilePreview(event, previewId, append = false) {
  const preview = $(previewId);
  const files = Array.from(event.target.files || []);
  if (!append) preview.innerHTML = '';

  files.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.alt = file.name;
      img.src = URL.createObjectURL(file);
      item.appendChild(img);
    } else {
      item.innerHTML = `<div class="file-chip">📄 ${escapeHtml(file.name)}</div>`;
    }
    preview.appendChild(item);
  });
}

async function uploadFiles(prefix, files, allowedPrefixes = STUDENT_UPLOAD_TYPES) {
  const uploadedPaths = [];
  const cleanPrefix = String(prefix).replace(/^\/+|\/+$/g, '');

  for (const [index, file] of files.entries()) {
    if (!isAllowedFile(file, allowedPrefixes)) {
      throw new Error(`${file.name} is not an allowed file type.`);
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new Error(`${file.name} is larger than 10 MB.`);
    }

    const path = `${cleanPrefix}/${Date.now()}-${index}-${safeFileName(file.name)}`;
    const { error } = await state.client.storage
      .from(STORAGE_BUCKET)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });

    if (error) throw error;
    uploadedPaths.push(path);
  }

  return uploadedPaths;
}

async function handleSubmitTask(event, task) {
  event.preventDefault();
  const stopBusy = setBusy(event.submitter, 'Submitting...');

  try {
    requireSession('student');
    const answer = $('studentAnswer').value.trim();
    const fileInputFiles = Array.from($('studentFileInput').files || []);
    const cameraFiles = Array.from($('studentCameraInput').files || []);
    const files = [...fileInputFiles, ...cameraFiles];
    const existingPaths = JSON.parse($('submissionExistingPaths').value || '[]');
    const uploadedPaths = await uploadFiles(`${state.email}/${task.id}`, files, STUDENT_UPLOAD_TYPES);
    const imagePaths = [...existingPaths, ...uploadedPaths];

    const { error } = await state.client.rpc('app_student_upsert_submission', {
      p_session_token: state.sessionToken,
      p_task_id: task.id,
      p_answer: answer,
      p_image_paths: imagePaths,
    });

    if (error) throw error;

    showToast('Task submitted successfully.');
    await loadStudentView();
    const refreshedTask = state.tasks.find((item) => item.id === task.id);
    if (refreshedTask) await renderStudentTaskPanel(refreshedTask);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

async function loadTeacherView() {
  if (state.role !== 'teacher' || !state.sessionToken) return;

  try {
    const [tasksResult, studentsResult, submissionsResult] = await Promise.all([
      state.client.rpc('app_teacher_tasks', { p_session_token: state.sessionToken }),
      state.client.rpc('app_teacher_approved_students', { p_session_token: state.sessionToken }),
      state.client.rpc('app_teacher_submissions', { p_session_token: state.sessionToken }),
    ]);

    if (tasksResult.error) throw tasksResult.error;
    if (studentsResult.error) throw studentsResult.error;
    if (submissionsResult.error) throw submissionsResult.error;

    state.tasks = tasksResult.data || [];
    state.approvedStudents = studentsResult.data || [];
    state.teacherSubmissions = submissionsResult.data || [];

    renderGradeOptions();
    renderTaskStudentSelect();
    renderTeacherFilters();
    renderTeacherTasks();
    renderApprovedStudents();
    await renderTeacherSubmissions();
    renderSelectedStudentDueList();
    renderScoresTab();
  } catch (error) {
    showToast(error.message, true);
  }
}

function switchTeacherTab(tabName) {
  document.querySelectorAll('[data-teacher-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.teacherTab === tabName);
  });

  document.querySelectorAll('.teacher-tab').forEach((section) => section.classList.add('hidden'));
  $(`teacher${tabName.charAt(0).toUpperCase()}${tabName.slice(1)}Tab`)?.classList.remove('hidden');
}

function renderGradeOptions() {
  const grades = [...new Set([
    ...state.approvedStudents.map((student) => student.grade).filter(Boolean),
    ...state.tasks.map((task) => task.grade).filter(Boolean),
  ])].sort((a, b) => String(a).localeCompare(String(b)));

  const list = $('gradeOptions');
  if (list) list.innerHTML = grades.map((grade) => `<option value="${escapeHtml(grade)}"></option>`).join('');
}

function renderTaskStudentSelect(selectedEmails = []) {
  const select = $('taskStudentSelect');
  if (!select) return;
  const selectedSet = new Set(selectedEmails);
  select.innerHTML = state.approvedStudents.map((student) => `
    <option value="${escapeHtml(student.email)}" ${selectedSet.has(student.email) ? 'selected' : ''}>
      ${escapeHtml(student.name || student.email)}${student.grade ? ' — ' + escapeHtml(student.grade) : ''}
    </option>
  `).join('');
}

function renderTeacherFilters() {
  const studentOptions = '<option value="all">All students</option>' + state.approvedStudents.map((student) => `
    <option value="${escapeHtml(student.email)}">${escapeHtml(student.name || student.email)}${student.grade ? ' — ' + escapeHtml(student.grade) : ''}</option>
  `).join('');

  ['taskStudentFilter', 'submissionStudentFilter', 'scoreStudentFilter'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = studentOptions;
    select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
  });

  const dueSelect = $('dueStudentSelect');
  if (dueSelect) {
    const current = dueSelect.value;
    dueSelect.innerHTML = '<option value="">Choose student...</option>' + state.approvedStudents.map((student) => `
      <option value="${escapeHtml(student.email)}">${escapeHtml(student.name || student.email)}${student.grade ? ' — ' + escapeHtml(student.grade) : ''}</option>
    `).join('');
    dueSelect.value = [...dueSelect.options].some((option) => option.value === current) ? current : '';
  }

  const grades = [...new Set([
    ...state.approvedStudents.map((student) => student.grade).filter(Boolean),
    ...state.tasks.map((task) => task.grade).filter(Boolean),
  ])].sort((a, b) => String(a).localeCompare(String(b)));

  const gradeOptions = '<option value="all">All grades</option>' + grades.map((grade) => `<option value="${escapeHtml(grade)}">${escapeHtml(grade)}</option>`).join('');
  ['taskGradeFilter', 'scoreGradeFilter'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = gradeOptions;
    select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
  });

  renderSubmissionTaskFilter();
}

function taskHasNoAllocation(task) {
  return !compactText(task.grade) && safeArray(task.assigned_student_emails).length === 0;
}

function isTaskForStudent(task, student) {
  if (!student) return false;
  if (taskHasNoAllocation(task)) return true;
  const assigned = safeArray(task.assigned_student_emails).map(normaliseEmail);
  const studentEmail = normaliseEmail(student.email);
  const taskGrade = compactText(task.grade).toLowerCase();
  const studentGrade = compactText(student.grade).toLowerCase();
  return assigned.includes(studentEmail) || (taskGrade && studentGrade && taskGrade === studentGrade);
}

function getStudentByEmail(email) {
  return state.approvedStudents.find((student) => student.email === email);
}

function getSubmission(studentEmail, taskId) {
  return state.teacherSubmissions.find((submission) => submission.student_email === studentEmail && submission.task_id === taskId);
}

async function handleSaveTask(event) {
  event.preventDefault();
  const stopBusy = setBusy(event.submitter, state.editingTaskId ? 'Updating...' : 'Saving...');

  try {
    requireSession('teacher');
    const selectedEmails = Array.from($('taskStudentSelect').selectedOptions || []).map((option) => normaliseEmail(option.value));
    const existingAttachmentPaths = JSON.parse($('taskExistingAttachmentPaths').value || '[]');
    const maxScoreValue = $('taskMaxScore').value;

    const basePayload = {
      p_session_token: state.sessionToken,
      p_task_id: state.editingTaskId || null,
      p_title: $('taskTitle').value.trim(),
      p_subject: $('taskSubject').value.trim() || null,
      p_grade: $('taskGrade').value.trim() || null,
      p_assigned_student_emails: selectedEmails,
      p_due_at: fromDatetimeLocal($('taskDueAt').value),
      p_max_score: maxScoreValue === '' ? null : Number(maxScoreValue),
      p_instructions: $('taskInstructions').value.trim(),
      p_link_url: $('taskLinkUrl').value.trim() || null,
      p_attachment_paths: existingAttachmentPaths,
      p_active: $('taskActive').checked,
    };

    const { data: savedTask, error } = await state.client.rpc('app_teacher_upsert_task', basePayload);
    if (error) throw error;

    const taskRow = Array.isArray(savedTask) ? savedTask[0] : savedTask;
    const files = Array.from($('taskFileInput').files || []);
    let finalPaths = existingAttachmentPaths;

    if (files.length) {
      const uploaded = await uploadFiles(`task-attachments/${taskRow.id}`, files, TEACHER_UPLOAD_TYPES);
      finalPaths = [...existingAttachmentPaths, ...uploaded];
      const { error: updateError } = await state.client.rpc('app_teacher_upsert_task', {
        ...basePayload,
        p_task_id: taskRow.id,
        p_attachment_paths: finalPaths,
      });
      if (updateError) throw updateError;
    }

    resetTaskForm();
    showToast('Task saved.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

function resetTaskForm() {
  $('taskForm')?.reset();
  $('taskActive').checked = true;
  $('taskExistingAttachmentPaths').value = '[]';
  $('taskFilePreview').innerHTML = '';
  $('taskExistingFiles').innerHTML = '';
  state.editingTaskId = null;
  renderTaskStudentSelect();
}

function renderTeacherTasks() {
  const list = $('teacherTasksList');
  const selectedStudentEmail = $('taskStudentFilter')?.value || 'all';
  const selectedGrade = $('taskGradeFilter')?.value || 'all';
  let tasks = [...state.tasks];

  if (selectedStudentEmail !== 'all') {
    const student = getStudentByEmail(selectedStudentEmail);
    tasks = tasks.filter((task) => isTaskForStudent(task, student));
  }
  if (selectedGrade !== 'all') {
    tasks = tasks.filter((task) => compactText(task.grade) === selectedGrade || taskHasNoAllocation(task));
  }

  if (!tasks.length) {
    list.innerHTML = '<div class="empty-state"><p>No tasks found.</p></div>';
    return;
  }

  list.innerHTML = tasks.map((task) => {
    const assigned = safeArray(task.assigned_student_emails);
    return `
      <article class="teacher-row">
        <h4>${escapeHtml(task.title)}</h4>
        <p class="muted">${escapeHtml(task.subject || 'General')} ${task.grade ? '• ' + escapeHtml(task.grade) : ''} • Due: ${escapeHtml(formatDateTime(task.due_at || task.due_date))}</p>
        <pre class="answer-display">${escapeHtml((task.instructions || '').slice(0, 280))}${(task.instructions || '').length > 280 ? '...' : ''}</pre>
        <div class="meta-row">
          <span class="pill ${task.active ? '' : 'gray'}">${task.active ? 'Active' : 'Hidden'}</span>
          <span class="pill gray">${assigned.length ? `${assigned.length} selected student(s)` : (task.grade ? 'Grade allocation' : 'All students')}</span>
          ${safeArray(task.attachment_paths).length ? `<span class="pill gray">${safeArray(task.attachment_paths).length} file(s)</span>` : ''}
          ${task.max_score !== null && task.max_score !== undefined ? `<span class="pill">Max: ${escapeHtml(task.max_score)}</span>` : ''}
        </div>
        <div class="row-actions no-print">
          <button class="btn btn-ghost" data-edit-task="${task.id}" type="button">Edit</button>
          <button class="btn btn-ghost" data-toggle-task="${task.id}" type="button">${task.active ? 'Hide' : 'Show'}</button>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('[data-edit-task]').forEach((button) => {
    button.addEventListener('click', () => populateTaskForm(button.dataset.editTask));
  });

  list.querySelectorAll('[data-toggle-task]').forEach((button) => {
    button.addEventListener('click', () => toggleTaskActive(button.dataset.toggleTask));
  });
}

async function populateTaskForm(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  state.editingTaskId = task.id;
  $('taskTitle').value = task.title || '';
  $('taskSubject').value = task.subject || '';
  $('taskGrade').value = task.grade || '';
  $('taskDueAt').value = toDatetimeLocal(task.due_at || task.due_date);
  $('taskMaxScore').value = task.max_score ?? '';
  $('taskInstructions').value = task.instructions || '';
  $('taskLinkUrl').value = task.link_url || '';
  $('taskActive').checked = Boolean(task.active);
  $('taskExistingAttachmentPaths').value = JSON.stringify(safeArray(task.attachment_paths));
  $('taskFilePreview').innerHTML = '';
  renderTaskStudentSelect(safeArray(task.assigned_student_emails));
  $('taskExistingFiles').innerHTML = await renderStoredFiles(safeArray(task.attachment_paths), 'Current task files');
  $('taskTitle').focus();
  showToast('Editing task. Press Save task when done.');
}

async function toggleTaskActive(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  try {
    requireSession('teacher');
    const { error } = await state.client.rpc('app_teacher_set_task_active', {
      p_session_token: state.sessionToken,
      p_task_id: taskId,
      p_active: !task.active,
    });

    if (error) throw error;
    showToast(task.active ? 'Task hidden from students.' : 'Task visible to students.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleApproveStudent(event) {
  event.preventDefault();
  const stopBusy = setBusy(event.submitter, 'Saving...');

  try {
    requireSession('teacher');
    const { error } = await state.client.rpc('app_teacher_upsert_student', {
      p_session_token: state.sessionToken,
      p_email: normaliseEmail($('approvedStudentEmail').value),
      p_name: $('approvedStudentName').value.trim() || null,
      p_grade: $('approvedStudentGrade').value.trim() || null,
      p_password: $('approvedStudentPassword').value || null,
      p_active: $('approvedStudentActive').checked,
    });

    if (error) throw error;

    $('studentApprovalForm').reset();
    $('approvedStudentActive').checked = true;
    showToast('Student saved with grade/password.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

function renderApprovedStudents() {
  const list = $('approvedStudentsList');
  if (!state.approvedStudents.length) {
    list.innerHTML = '<div class="empty-state"><p>No approved students yet.</p></div>';
    return;
  }

  list.innerHTML = state.approvedStudents.map((student) => `
    <article class="teacher-row">
      <h4>${escapeHtml(student.name || 'Student')}</h4>
      <p class="muted">${escapeHtml(student.email)} ${student.grade ? '• ' + escapeHtml(student.grade) : ''}</p>
      <div class="meta-row">
        <span class="pill ${student.active ? '' : 'gray'}">${student.active ? 'Active' : 'Blocked'}</span>
        <span class="pill ${student.has_password ? '' : 'danger'}">${student.has_password ? 'Password set' : 'No password yet'}</span>
      </div>
      <div class="row-actions no-print">
        <button class="btn btn-ghost" data-fill-student="${escapeHtml(student.email)}" type="button">Edit</button>
        <button class="btn btn-ghost" data-toggle-student="${escapeHtml(student.email)}" type="button">${student.active ? 'Block' : 'Allow'}</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('[data-toggle-student]').forEach((button) => {
    button.addEventListener('click', () => toggleStudentActive(button.dataset.toggleStudent));
  });

  list.querySelectorAll('[data-fill-student]').forEach((button) => {
    button.addEventListener('click', () => populateStudentForm(button.dataset.fillStudent));
  });
}

function populateStudentForm(email) {
  const student = state.approvedStudents.find((item) => item.email === email);
  if (!student) return;
  $('approvedStudentName').value = student.name || '';
  $('approvedStudentEmail').value = student.email || '';
  $('approvedStudentGrade').value = student.grade || '';
  $('approvedStudentPassword').value = '';
  $('approvedStudentPassword').placeholder = 'Leave blank to keep existing password';
  $('approvedStudentActive').checked = Boolean(student.active);
  $('approvedStudentName').focus();
}

async function toggleStudentActive(email) {
  const student = state.approvedStudents.find((item) => item.email === email);
  if (!student) return;

  try {
    requireSession('teacher');
    const { error } = await state.client.rpc('app_teacher_set_student_active', {
      p_session_token: state.sessionToken,
      p_email: email,
      p_active: !student.active,
    });

    if (error) throw error;
    showToast(student.active ? 'Student blocked.' : 'Student allowed.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderSubmissionTaskFilter() {
  const select = $('submissionTaskFilter');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="all">All tasks</option>' + state.tasks.map((task) =>
    `<option value="${task.id}">${escapeHtml(task.title)}</option>`
  ).join('');
  select.value = currentValue && [...select.options].some((opt) => opt.value === currentValue) ? currentValue : 'all';
}

async function renderTeacherSubmissions() {
  const list = $('submissionsList');
  const taskFilter = $('submissionTaskFilter')?.value || 'all';
  const studentFilter = $('submissionStudentFilter')?.value || 'all';
  const statusFilter = $('submissionStatusFilter')?.value || 'all';
  const searchQuery = $('submissionStudentSearch')?.value.trim().toLowerCase() || '';

  let submissions = [...state.teacherSubmissions];

  if (taskFilter !== 'all') submissions = submissions.filter((submission) => submission.task_id === taskFilter);
  if (studentFilter !== 'all') submissions = submissions.filter((submission) => submission.student_email === studentFilter);
  if (statusFilter !== 'all') submissions = submissions.filter((submission) => submission.status === statusFilter);
  if (searchQuery) {
    submissions = submissions.filter((submission) =>
      `${submission.student_email || ''} ${submission.student_name || ''} ${submission.task_title || ''} ${submission.answer || ''}`.toLowerCase().includes(searchQuery)
    );
  }

  $('printGeneratedText').textContent = `Generated: ${new Date().toLocaleString('en-ZA')}`;

  if (!submissions.length) {
    list.innerHTML = '<div class="empty-state"><p>No submissions found.</p></div>';
    return;
  }

  const cards = await Promise.all(submissions.map(async (submission) => {
    const studentFilesHtml = await renderStoredFiles(safeArray(submission.image_paths), 'Student upload(s)');
    const correctionFilesHtml = await renderStoredFiles(safeArray(submission.correction_paths), 'Teacher correction file(s)');

    return `
      <article class="submission-card list-row" data-submission-card="${submission.id}">
        <div class="submission-list-head">
          <div>
            <h3>${escapeHtml(submission.task_title || 'Task')}</h3>
            <p class="muted">
              ${escapeHtml(submission.task_subject || 'General')} •
              Student: ${escapeHtml(submission.student_name || submission.student_email)} ${submission.student_grade ? '(' + escapeHtml(submission.student_grade) + ')' : ''} •
              Submitted: ${escapeHtml(formatSubmittedDateTime(submission.submitted_at))}
            </p>
          </div>
          <div class="score-badge">${submission.score !== null && submission.score !== undefined ? `${escapeHtml(submission.score)}${submission.task_max_score ? ' / ' + escapeHtml(submission.task_max_score) : ''}` : 'No score'}</div>
        </div>
        <div class="meta-row">
          <span class="pill">${escapeHtml((submission.status || 'submitted').replace('_', ' '))}</span>
          <span class="pill warning">Due: ${escapeHtml(formatDateTime(submission.task_due_at || submission.task_due_date))}</span>
        </div>

        <details>
          <summary>Open answer and files</summary>
          <h4>Student written answer</h4>
          <pre class="answer-display">${escapeHtml(submission.answer || 'No written answer.')}</pre>
          ${studentFilesHtml}
          ${correctionFilesHtml}
        </details>

        <div class="card-form no-print review-grid" style="margin-top: 1rem;">
          <label>
            Review status
            <select data-review-status="${submission.id}">
              ${['submitted', 'reviewed', 'needs_correction'].map((status) =>
                `<option value="${status}" ${submission.status === status ? 'selected' : ''}>${status.replace('_', ' ')}</option>`
              ).join('')}
            </select>
          </label>
          <label>
            Score
            <input data-review-score="${submission.id}" type="number" min="0" step="0.5" value="${submission.score ?? ''}" placeholder="Score" />
          </label>
          <label class="review-feedback">
            Teacher feedback
            <textarea rows="3" data-review-feedback="${submission.id}" placeholder="Optional feedback for student...">${escapeHtml(submission.feedback || '')}</textarea>
          </label>
          <label>
            Upload correction file/image/PDF
            <input data-review-files="${submission.id}" type="file" accept="image/*,application/pdf" multiple />
          </label>
          <button class="btn btn-primary" data-save-review="${submission.id}" type="button">Save review</button>
        </div>
      </article>
    `;
  }));

  list.innerHTML = cards.join('');

  list.querySelectorAll('[data-save-review]').forEach((button) => {
    button.addEventListener('click', () => saveReview(button.dataset.saveReview, button));
  });
}

async function saveReview(submissionId, button) {
  const stopBusy = setBusy(button, 'Saving...');

  try {
    requireSession('teacher');
    const submission = state.teacherSubmissions.find((item) => item.id === submissionId);
    if (!submission) throw new Error('Submission not found.');

    const status = document.querySelector(`[data-review-status="${submissionId}"]`).value;
    const feedback = document.querySelector(`[data-review-feedback="${submissionId}"]`).value.trim() || null;
    const scoreValue = document.querySelector(`[data-review-score="${submissionId}"]`).value;
    const files = Array.from(document.querySelector(`[data-review-files="${submissionId}"]`).files || []);
    const existingCorrections = safeArray(submission.correction_paths);
    const uploadedCorrections = files.length
      ? await uploadFiles(`corrections/${submission.student_email}/${submission.id}`, files, TEACHER_UPLOAD_TYPES)
      : [];

    const { error } = await state.client.rpc('app_teacher_save_review', {
      p_session_token: state.sessionToken,
      p_submission_id: submissionId,
      p_status: status,
      p_feedback: feedback,
      p_score: scoreValue === '' ? null : Number(scoreValue),
      p_correction_paths: [...existingCorrections, ...uploadedCorrections],
    });

    if (error) throw error;
    showToast('Review saved.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

function renderSelectedStudentDueList() {
  const wrap = $('studentDueList');
  if (!wrap) return;
  const email = $('dueStudentSelect')?.value || '';
  if (!email) {
    wrap.innerHTML = '<p class="muted">Choose a student to see submitted, open, and overdue tasks.</p>';
    return;
  }

  const student = getStudentByEmail(email);
  if (!student) {
    wrap.innerHTML = '<p class="muted">Student not found.</p>';
    return;
  }

  const tasks = state.tasks.filter((task) => isTaskForStudent(task, student) && task.active);
  if (!tasks.length) {
    wrap.innerHTML = '<p class="muted">No tasks allocated to this student.</p>';
    return;
  }

  const rows = tasks
    .sort((a, b) => (getDueAt(a)?.getTime() || Infinity) - (getDueAt(b)?.getTime() || Infinity))
    .map((task) => {
      const submission = getSubmission(student.email, task.id);
      const overdue = !submission && isTaskOverdue(task);
      const status = submission ? 'Submitted' : overdue ? 'Overdue' : 'Due';
      return `
        <tr>
          <td>${escapeHtml(task.title)}</td>
          <td>${escapeHtml(task.subject || 'General')}</td>
          <td>${escapeHtml(formatDateTime(task.due_at || task.due_date))}</td>
          <td><span class="pill ${overdue ? 'danger' : submission ? '' : 'warning'}">${status}</span></td>
          <td>${submission?.score ?? ''}</td>
        </tr>
      `;
    }).join('');

  wrap.innerHTML = `
    <div class="table-wrap small-table">
      <table>
        <thead><tr><th>Task</th><th>Subject</th><th>Due</th><th>Status</th><th>Score</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderScoresTab() {
  const wrap = $('scoreTableWrap');
  if (!wrap) return;
  const gradeFilter = $('scoreGradeFilter')?.value || 'all';
  const studentFilter = $('scoreStudentFilter')?.value || 'all';
  const search = $('scoreSearch')?.value.trim().toLowerCase() || '';

  let students = state.approvedStudents.filter((student) => student.active);
  if (gradeFilter !== 'all') students = students.filter((student) => compactText(student.grade) === gradeFilter);
  if (studentFilter !== 'all') students = students.filter((student) => student.email === studentFilter);
  if (search) students = students.filter((student) => `${student.name || ''} ${student.email || ''}`.toLowerCase().includes(search));

  const tasks = state.tasks
    .filter((task) => task.active)
    .filter((task) => !search || `${task.title || ''} ${task.subject || ''}`.toLowerCase().includes(search) || students.some((s) => `${s.name || ''} ${s.email || ''}`.toLowerCase().includes(search)))
    .sort((a, b) => (getDueAt(a)?.getTime() || Infinity) - (getDueAt(b)?.getTime() || Infinity));

  if (!students.length || !tasks.length) {
    wrap.innerHTML = '<div class="empty-state"><p>No score data found for the current filters.</p></div>';
    return;
  }

  const taskHeaders = tasks.map((task) => `<th title="${escapeHtml(task.title)}">${escapeHtml((task.title || '').slice(0, 18))}${(task.title || '').length > 18 ? '...' : ''}</th>`).join('');

  const rows = students.map((student) => {
    let total = 0;
    let maxTotal = 0;
    const cells = tasks.map((task) => {
      if (!isTaskForStudent(task, student)) return '<td class="muted">—</td>';
      const submission = getSubmission(student.email, task.id);
      const score = submission?.score;
      const max = Number(task.max_score || 0);
      if (score !== null && score !== undefined && score !== '') total += Number(score);
      if (max) maxTotal += max;
      return `<td>${score !== null && score !== undefined ? escapeHtml(score) : ''}${max ? `<span class="muted">/${escapeHtml(max)}</span>` : ''}</td>`;
    }).join('');
    return `
      <tr>
        <td><strong>${escapeHtml(student.name || 'Student')}</strong><br><span class="muted">${escapeHtml(student.email)}${student.grade ? ' • ' + escapeHtml(student.grade) : ''}</span></td>
        ${cells}
        <td><strong>${escapeHtml(total)}</strong>${maxTotal ? `<span class="muted">/${escapeHtml(maxTotal)}</span>` : ''}</td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table class="score-table">
      <thead>
        <tr><th>Student</th>${taskHeaders}<th>Total</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function createSignedUrls(paths) {
  if (!paths?.length) return [];

  const urls = await Promise.all(paths.map(async (path) => {
    const { data, error } = await state.client.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(path, 60 * 60);

    if (error) {
      console.warn('Signed URL error:', error.message);
      return null;
    }
    return { path, url: data?.signedUrl || null };
  }));

  return urls.filter((item) => item?.url);
}

async function renderStoredFiles(paths, heading = 'Files') {
  if (!paths?.length) return `<p class="muted">No ${escapeHtml(heading.toLowerCase())}.</p>`;
  const files = await createSignedUrls(paths);
  if (!files.length) return `<p class="muted">Could not load ${escapeHtml(heading.toLowerCase())}.</p>`;

  const items = files.map(({ path, url }) => {
    const label = fileLabelFromPath(path);
    if (isImagePath(path)) {
      return `<a class="file-preview-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="preview-image" src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" /><span>${escapeHtml(label)}</span></a>`;
    }
    if (isPdfPath(path)) {
      return `<a class="file-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">📄 ${escapeHtml(label)}</a>`;
    }
    return `<a class="file-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">📎 ${escapeHtml(label)}</a>`;
  }).join('');

  return `<h4>${escapeHtml(heading)}</h4><div class="file-grid">${items}</div>`;
}

init();
