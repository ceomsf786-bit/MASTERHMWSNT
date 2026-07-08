const STORAGE_BUCKET = 'submission-images';

const state = {
  client: null,
  session: null,
  user: null,
  role: null,
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
  toast.style.background = isError ? '#7f1d1d' : '#102018';
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 4200);
}

function isConfigReady() {
  return window.SNT_SUPABASE_URL &&
    window.SNT_SUPABASE_ANON_KEY &&
    !window.SNT_SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
    !window.SNT_SUPABASE_ANON_KEY.includes('YOUR-SUPABASE');
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
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    }
  );

  const { data, error } = await state.client.auth.getSession();
  if (error) {
    showToast(error.message, true);
  }

  state.session = data?.session || null;
  state.user = state.session?.user || null;

  state.client.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    state.user = session?.user || null;
    await routeUser();
  });

  await routeUser();
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
  const formButton = event.submitter;
  const stopBusy = setBusy(formButton, 'Sending...');
  const email = normaliseEmail($('emailInput').value);

  try {
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await state.client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: true,
      },
    });

    if (error) throw error;

    $('loginMessage').textContent = 'Check your email. Click the secure login link to open SNT Task Submit.';
    $('loginMessage').classList.remove('hidden');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    stopBusy();
  }
}

async function handleLogout() {
  if (!state.client) return;
  await state.client.auth.signOut();
  state.session = null;
  state.user = null;
  state.role = null;
  showScreen('loginScreen');
  $('logoutBtn').classList.add('hidden');
  $('userBadge').classList.add('hidden');
}

async function routeUser() {
  if (!state.user) {
    $('logoutBtn').classList.add('hidden');
    $('userBadge').classList.add('hidden');
    showScreen('loginScreen');
    return;
  }

  const email = normaliseEmail(state.user.email);
  $('userBadge').textContent = email;
  $('userBadge').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');

  try {
    const role = await getUserRole(email);
    state.role = role;

    if (role === 'teacher') {
      showScreen('teacherScreen');
      await loadTeacherView();
      return;
    }

    if (role === 'student') {
      showScreen('studentScreen');
      await loadStudentView();
      return;
    }

    showScreen('blockedScreen');
  } catch (error) {
    showToast(error.message, true);
    showScreen('blockedScreen');
  }
}

async function getUserRole(email) {
  const { data: teacherRows, error: teacherError } = await state.client
    .from('teacher_users')
    .select('email, active')
    .eq('email', email)
    .eq('active', true)
    .limit(1);

  if (teacherError) throw teacherError;
  if (teacherRows?.length) return 'teacher';

  const { data: studentRows, error: studentError } = await state.client
    .from('approved_students')
    .select('email, active')
    .eq('email', email)
    .eq('active', true)
    .limit(1);

  if (studentError) throw studentError;
  if (studentRows?.length) return 'student';

  return 'blocked';
}

async function loadStudentView() {
  if (!state.user) return;

  try {
    const [{ data: tasks, error: tasksError }, { data: submissions, error: submissionsError }] = await Promise.all([
      state.client.from('tasks').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }),
      state.client.from('submissions').select('*').eq('student_id', state.user.id),
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
  const uploadedPaths = [];
  const maxSize = 10 * 1024 * 1024;

  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith('image/')) {
      throw new Error(`${file.name} is not an image file.`);
    }
    if (file.size > maxSize) {
      throw new Error(`${file.name} is larger than 10 MB.`);
    }

    const path = `${state.user.id}/${taskId}/${Date.now()}-${index}-${safeFileName(file.name)}`;
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
    const answer = $('studentAnswer').value.trim();
    const files = Array.from($('studentImageInput').files || []);
    const existingPaths = JSON.parse($('submissionExistingPaths').value || '[]');
    const uploadedPaths = await uploadStudentImages(task.id, files);
    const imagePaths = [...existingPaths, ...uploadedPaths];

    const payload = {
      task_id: task.id,
      student_id: state.user.id,
      student_email: normaliseEmail(state.user.email),
      answer,
      image_paths: imagePaths,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
    };

    const { error } = await state.client
      .from('submissions')
      .upsert(payload, { onConflict: 'task_id,student_id' });

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
  try {
    const [tasksResult, studentsResult, submissionsResult] = await Promise.all([
      state.client.from('tasks').select('*').order('created_at', { ascending: false }),
      state.client.from('approved_students').select('*').order('created_at', { ascending: false }),
      state.client.from('submissions').select('*, tasks(title, subject, due_date)').order('submitted_at', { ascending: false }),
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

  const payload = {
    title: $('taskTitle').value.trim(),
    subject: $('taskSubject').value.trim() || null,
    due_date: $('taskDueDate').value || null,
    instructions: $('taskInstructions').value.trim(),
    image_url: $('taskImageUrl').value.trim() || null,
    link_url: $('taskLinkUrl').value.trim() || null,
    active: $('taskActive').checked,
    updated_at: new Date().toISOString(),
  };

  try {
    let result;
    if (state.editingTaskId) {
      result = await state.client.from('tasks').update(payload).eq('id', state.editingTaskId);
    } else {
      result = await state.client.from('tasks').insert({ ...payload, created_by: state.user.id });
    }

    if (result.error) throw result.error;

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
    const { error } = await state.client
      .from('tasks')
      .update({ active: !task.active, updated_at: new Date().toISOString() })
      .eq('id', taskId);

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

  const payload = {
    email: normaliseEmail($('approvedStudentEmail').value),
    name: $('approvedStudentName').value.trim() || null,
    active: $('approvedStudentActive').checked,
  };

  try {
    const { error } = await state.client
      .from('approved_students')
      .upsert(payload, { onConflict: 'email' });

    if (error) throw error;

    $('studentApprovalForm').reset();
    $('approvedStudentActive').checked = true;
    showToast('Student approval saved.');
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
      </div>
      <div class="row-actions no-print">
        <button class="btn btn-ghost" data-toggle-student="${escapeHtml(student.email)}" type="button">${student.active ? 'Block' : 'Allow'}</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('[data-toggle-student]').forEach((button) => {
    button.addEventListener('click', () => toggleStudentActive(button.dataset.toggleStudent));
  });
}

async function toggleStudentActive(email) {
  const student = state.approvedStudents.find((item) => item.email === email);
  if (!student) return;

  try {
    const { error } = await state.client
      .from('approved_students')
      .update({ active: !student.active })
      .eq('email', email);

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
        <h3>${escapeHtml(submission.tasks?.title || 'Task')}</h3>
        <p class="muted">
          ${escapeHtml(submission.tasks?.subject || 'General')} •
          Student: ${escapeHtml(submission.student_email)} •
          Submitted: ${escapeHtml(formatDateTime(submission.submitted_at))}
        </p>
        <div class="meta-row">
          <span class="pill">${escapeHtml(submission.status || 'submitted')}</span>
          <span class="pill warning">Due: ${escapeHtml(formatDate(submission.tasks?.due_date))}</span>
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
    const status = document.querySelector(`[data-review-status="${submissionId}"]`).value;
    const feedback = document.querySelector(`[data-review-feedback="${submissionId}"]`).value.trim() || null;
    const { error } = await state.client
      .from('submissions')
      .update({
        status,
        feedback,
        reviewed_at: new Date().toISOString(),
        reviewed_by: state.user.id,
      })
      .eq('id', submissionId);

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
