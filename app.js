const STORAGE_BUCKET = 'submission-images';

const state = {
  client: null,
  sessionToken: null,
  sessionExpiresAt: null,
  role: null,
  email: null,
  name: null,
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

function formatDate(value) {
  if (!value) return 'No due date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#7f1d1d' : '#064e3b';
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 4200);
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
  $('studentApprovalForm')?.addEventListener('submit', handleApproveStudent);
  $('submissionTaskFilter')?.addEventListener('change', renderTeacherSubmissions);
  $('submissionStudentSearch')?.addEventListener('input', renderTeacherSubmissions);
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

  window.localStorage.setItem('snt_session_token', state.sessionToken);
  window.localStorage.setItem('snt_session_role', state.role);
  window.localStorage.setItem('snt_session_email', state.email);
  window.localStorage.setItem('snt_session_name', state.name || '');
  window.localStorage.setItem('snt_session_expires_at', state.sessionExpiresAt || '');

  updateUserBadge();
}

function clearSession() {
  window.localStorage.removeItem('snt_session_token');
  window.localStorage.removeItem('snt_session_role');
  window.localStorage.removeItem('snt_session_email');
  window.localStorage.removeItem('snt_session_name');
  window.localStorage.removeItem('snt_session_expires_at');

  state.sessionToken = null;
  state.sessionExpiresAt = null;
  state.role = null;
  state.email = null;
  state.name = null;
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
  $('userBadge').textContent = `${roleLabel}: ${namePart}${state.email}`;
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
      if (selected) renderStudentTaskPanel(selected);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function getSubmissionForTask(taskId) {
  return state.submissions.find((submission) => submission.task_id === taskId);
}

function isTaskOverdue(task) {
  if (!task.due_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${task.due_date}T00:00:00`);
  return due < today;
}

function renderStudentTasksList() {
  const list = $('studentTasksList');
  const query = $('studentSearch')?.value.trim().toLowerCase() || '';
  const filter = $('studentStatusFilter')?.value || 'all';

  let tasks = [...state.tasks];

  if (query) {
    tasks = tasks.filter((task) =>
      `${task.title || ''} ${task.subject || ''} ${task.instructions || ''}`.toLowerCase().includes(query)
    );
  }

  if (filter !== 'all') {
    tasks = tasks.filter((task) => {
      const submitted = Boolean(getSubmissionForTask(task.id));
      return filter === 'submitted' ? submitted : !submitted;
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
        <p class="muted">${escapeHtml(task.subject || 'General')}</p>
        <div class="meta-row">
          <span class="pill ${submitted ? '' : 'gray'}">${submitted ? 'Submitted' : 'Open'}</span>
          <span class="pill ${overdue ? 'danger' : 'warning'}">Due: ${escapeHtml(formatDate(task.due_date))}</span>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('[data-task-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const task = state.tasks.find((item) => item.id === card.dataset.taskId);
      if (!task) return;
      state.selectedTaskId = task.id;
      renderStudentTasksList();
      renderStudentTaskPanel(task);
    });
  });
}

async function renderStudentTaskPanel(task) {
  const panel = $('studentTaskPanel');
  const submission = getSubmissionForTask(task.id);
  const savedAnswer = submission?.answer || '';
  const savedPaths = submission?.image_paths || [];
  const savedImagesHtml = savedPaths.length
    ? `<div class="image-grid" id="studentSavedImages"><p class="muted">Loading saved images...</p></div>`
    : '';

  panel.innerHTML = `
    <div class="task-detail">
      <div class="screen-title">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="muted">${escapeHtml(task.subject || 'General')} • Due: ${escapeHtml(formatDate(task.due_date))}</p>
        </div>
        <span class="pill ${submission ? '' : 'gray'}">${submission ? 'Already submitted' : 'Not submitted yet'}</span>
      </div>

      <h4>Teacher instructions</h4>
      <pre class="answer-display">${escapeHtml(task.instructions || '')}</pre>
      ${task.image_url ? `<img class="task-detail-image" src="${escapeHtml(task.image_url)}" alt="Teacher task image" loading="lazy" />` : ''}
      ${task.link_url ? `<p><a href="${escapeHtml(task.link_url)}" target="_blank" rel="noopener">Open teacher link</a></p>` : ''}

      <form id="submissionForm" class="stack">
        <input type="hidden" id="submissionExistingPaths" value="${escapeHtml(JSON.stringify(savedPaths))}" />
        <label>
          Student written answer
          <textarea id="studentAnswer" class="answer-box" placeholder="Type your answer here..." required>${escapeHtml(savedAnswer)}</textarea>
        </label>
        <label>
          Upload image/photo of work (optional)
          <input id="studentImageInput" type="file" accept="image/*" multiple />
        </label>
        <div id="imagePreview" class="preview-grid"></div>
        ${savedImagesHtml}
        ${submission ? `<p class="notice">Last submitted: ${escapeHtml(formatDateTime(submission.submitted_at))}</p>` : ''}
        ${submission?.feedback ? `<p class="notice"><strong>Teacher feedback:</strong><br>${escapeHtml(submission.feedback)}</p>` : ''}
        <button class="btn btn-primary" type="submit">Submit task</button>
      </form>
    </div>
  `;

  $('studentImageInput').addEventListener('change', handleImagePreview);
  $('submissionForm').addEventListener('submit', (event) => handleSubmitTask(event, task));

  if (savedPaths.length) {
    const urls = await createSignedUrls(savedPaths);
    const target = $('studentSavedImages');
    target.innerHTML = urls.map((url) => `<img class="preview-image" src="${escapeHtml(url)}" alt="Saved submitted image" loading="lazy" />`).join('');
  }
}

function handleImagePreview(event) {
  const preview = $('imagePreview');
  const files = Array.from(event.target.files || []);
  preview.innerHTML = '';

  files.forEach((file) => {
    if (!file.type.startsWith('image/')) return;
    const img = document.createElement('img');
    img.className = 'preview-image';
    img.alt = file.name;
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
  });
}

function safeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
}

async function uploadStudentImages(taskId, files) {
  requireSession('student');
  const uploadedPaths = [];
  const maxSize = 10 * 1024 * 1024;
  const folderEmail = state.email;

  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith('image/')) {
      throw new Error(`${file.name} is not an image file.`);
    }
    if (file.size > maxSize) {
      throw new Error(`${file.name} is larger than 10 MB.`);
    }

    const path = `${folderEmail}/${taskId}/${Date.now()}-${index}-${safeFileName(file.name)}`;
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
    const files = Array.from($('studentImageInput').files || []);
    const existingPaths = JSON.parse($('submissionExistingPaths').value || '[]');
    const uploadedPaths = await uploadStudentImages(task.id, files);
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
    if (refreshedTask) renderStudentTaskPanel(refreshedTask);
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

    renderTeacherTasks();
    renderApprovedStudents();
    renderSubmissionTaskFilter();
    await renderTeacherSubmissions();
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

async function handleSaveTask(event) {
  event.preventDefault();
  const stopBusy = setBusy(event.submitter, state.editingTaskId ? 'Updating...' : 'Saving...');

  try {
    requireSession('teacher');
    const { error } = await state.client.rpc('app_teacher_upsert_task', {
      p_session_token: state.sessionToken,
      p_task_id: state.editingTaskId || null,
      p_title: $('taskTitle').value.trim(),
      p_subject: $('taskSubject').value.trim() || null,
      p_due_date: $('taskDueDate').value || null,
      p_instructions: $('taskInstructions').value.trim(),
      p_image_url: $('taskImageUrl').value.trim() || null,
      p_link_url: $('taskLinkUrl').value.trim() || null,
      p_active: $('taskActive').checked,
    });

    if (error) throw error;

    $('taskForm').reset();
    $('taskActive').checked = true;
    state.editingTaskId = null;
    showToast('Task saved.');
    await loadTeacherView();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

function renderTeacherTasks() {
  const list = $('teacherTasksList');
  if (!state.tasks.length) {
    list.innerHTML = '<div class="empty-state"><p>No tasks created yet.</p></div>';
    return;
  }

  list.innerHTML = state.tasks.map((task) => `
    <article class="teacher-row">
      <h4>${escapeHtml(task.title)}</h4>
      <p class="muted">${escapeHtml(task.subject || 'General')} • Due: ${escapeHtml(formatDate(task.due_date))}</p>
      <pre class="answer-display">${escapeHtml((task.instructions || '').slice(0, 280))}${(task.instructions || '').length > 280 ? '...' : ''}</pre>
      <div class="meta-row">
        <span class="pill ${task.active ? '' : 'gray'}">${task.active ? 'Active' : 'Hidden'}</span>
        ${task.image_url ? '<span class="pill gray">Has image</span>' : ''}
        ${task.link_url ? '<span class="pill gray">Has link</span>' : ''}
      </div>
      <div class="row-actions no-print">
        <button class="btn btn-ghost" data-edit-task="${task.id}" type="button">Edit</button>
        <button class="btn btn-ghost" data-toggle-task="${task.id}" type="button">${task.active ? 'Hide' : 'Show'}</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('[data-edit-task]').forEach((button) => {
    button.addEventListener('click', () => populateTaskForm(button.dataset.editTask));
  });

  list.querySelectorAll('[data-toggle-task]').forEach((button) => {
    button.addEventListener('click', () => toggleTaskActive(button.dataset.toggleTask));
  });
}

function populateTaskForm(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  state.editingTaskId = task.id;
  $('taskTitle').value = task.title || '';
  $('taskSubject').value = task.subject || '';
  $('taskDueDate').value = task.due_date || '';
  $('taskInstructions').value = task.instructions || '';
  $('taskImageUrl').value = task.image_url || '';
  $('taskLinkUrl').value = task.link_url || '';
  $('taskActive').checked = Boolean(task.active);
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
      p_password: $('approvedStudentPassword').value || null,
      p_active: $('approvedStudentActive').checked,
    });

    if (error) throw error;

    $('studentApprovalForm').reset();
    $('approvedStudentActive').checked = true;
    showToast('Student saved with password.');
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
      <p class="muted">${escapeHtml(student.email)}</p>
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
  const currentValue = select.value;
  select.innerHTML = '<option value="all">All tasks</option>' + state.tasks.map((task) =>
    `<option value="${task.id}">${escapeHtml(task.title)}</option>`
  ).join('');
  select.value = currentValue && [...select.options].some((opt) => opt.value === currentValue) ? currentValue : 'all';
}

async function renderTeacherSubmissions() {
  const list = $('submissionsList');
  const taskFilter = $('submissionTaskFilter')?.value || 'all';
  const studentQuery = $('submissionStudentSearch')?.value.trim().toLowerCase() || '';

  let submissions = [...state.teacherSubmissions];

  if (taskFilter !== 'all') {
    submissions = submissions.filter((submission) => submission.task_id === taskFilter);
  }

  if (studentQuery) {
    submissions = submissions.filter((submission) =>
      `${submission.student_email || ''} ${submission.answer || ''}`.toLowerCase().includes(studentQuery)
    );
  }

  $('printGeneratedText').textContent = `Generated: ${new Date().toLocaleString('en-ZA')}`;

  if (!submissions.length) {
    list.innerHTML = '<div class="empty-state"><p>No submissions found.</p></div>';
    return;
  }

  const cards = await Promise.all(submissions.map(async (submission) => {
    const imageUrls = await createSignedUrls(submission.image_paths || []);
    const imageHtml = imageUrls.length
      ? `<div class="image-grid">${imageUrls.map((url) => `<img class="submission-image" src="${escapeHtml(url)}" alt="Student submitted image" loading="lazy" />`).join('')}</div>`
      : '<p class="muted">No image uploaded.</p>';

    return `
      <article class="submission-card" data-submission-card="${submission.id}">
        <h3>${escapeHtml(submission.task_title || 'Task')}</h3>
        <p class="muted">
          ${escapeHtml(submission.task_subject || 'General')} •
          Student: ${escapeHtml(submission.student_email)} •
          Submitted: ${escapeHtml(formatDateTime(submission.submitted_at))}
        </p>
        <div class="meta-row">
          <span class="pill">${escapeHtml(submission.status || 'submitted')}</span>
          <span class="pill warning">Due: ${escapeHtml(formatDate(submission.task_due_date))}</span>
        </div>

        <h4>Student written answer</h4>
        <pre class="answer-display">${escapeHtml(submission.answer || 'No written answer.')}</pre>

        <h4>Student image(s)</h4>
        ${imageHtml}

        <div class="card-form no-print" style="margin-top: 1rem;">
          <label>
            Review status
            <select data-review-status="${submission.id}">
              ${['submitted', 'reviewed', 'needs_correction'].map((status) =>
                `<option value="${status}" ${submission.status === status ? 'selected' : ''}>${status.replace('_', ' ')}</option>`
              ).join('')}
            </select>
          </label>
          <label>
            Teacher feedback
            <textarea rows="3" data-review-feedback="${submission.id}" placeholder="Optional feedback for student...">${escapeHtml(submission.feedback || '')}</textarea>
          </label>
          <button class="btn btn-primary" data-save-review="${submission.id}" type="button">Save review</button>
        </div>
        ${submission.feedback ? `<p><strong>Feedback:</strong> ${escapeHtml(submission.feedback)}</p>` : ''}
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
    const status = document.querySelector(`[data-review-status="${submissionId}"]`).value;
    const feedback = document.querySelector(`[data-review-feedback="${submissionId}"]`).value.trim() || null;
    const { error } = await state.client.rpc('app_teacher_save_review', {
      p_session_token: state.sessionToken,
      p_submission_id: submissionId,
      p_status: status,
      p_feedback: feedback,
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
    return data?.signedUrl || null;
  }));

  return urls.filter(Boolean);
}

init();
