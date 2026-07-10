/* SNT Homework App Beta 10.7 - Supabase version
   Front-end uses only Supabase URL + publishable/anon key.
   Passwords are checked by Supabase RPC functions. Do not put secret keys in GitHub. */

const TASK_BUCKET = 'task-files';
const SUBMISSION_BUCKET = 'submission-files';
const CORRECTION_BUCKET = 'correction-files';
const SESSION_KEY = 'snt_beta_10_7_session';
const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDF_PAGE_DELAY_MS = 180;


const state = {
  client: null,
  session: null,
  students: [],
  teachers: [],
  tasks: [],
  studentTasks: [],
  submissions: [],
  selectedStudentTaskId: null,
  taskFileQueue: [],
  studentFileQueue: [],
  signedUrls: new Map(),
};

const $ = (id) => document.getElementById(id);
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]));
const truncate = (value, n = 120) => {
  const text = String(value || '');
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

function init() {
  if (!window.supabase || !window.SNT_SUPABASE_URL || !window.SNT_SUPABASE_ANON_KEY) {
    showToast('Supabase config missing. Check config.js.', true);
    return;
  }

  state.client = window.supabase.createClient(window.SNT_SUPABASE_URL, window.SNT_SUPABASE_ANON_KEY);
  setupPdfJs();
  bindStaticEvents();
  startPdfPreviewObserver();
  restoreSession();
}

document.addEventListener('DOMContentLoaded', init);

function bindStaticEvents() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('logoutBtn').addEventListener('click', handleLogout);
  $('refreshBtn').addEventListener('click', refreshCurrentView);

  $('studentSearch').addEventListener('input', renderStudentView);
  $('studentStatusFilter').addEventListener('change', renderStudentView);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showTeacherTab(btn.dataset.tab));
  });

  $('taskForm').addEventListener('submit', handleTaskFormSubmit);
  $('clearTaskFormBtn').addEventListener('click', clearTaskForm);
  $('taskFilesInput').addEventListener('change', (event) => addFilesToQueue('task', event.target.files));
  $('taskAllocationType').addEventListener('change', () => { renderTaskStudentPicker(); });
  $('teacherTaskOwnerFilter').addEventListener('change', renderTeacherTasks);
  $('teacherTaskSearch').addEventListener('input', renderTeacherTasks);

  $('studentForm').addEventListener('submit', handleStudentFormSubmit);
  $('teacherForm').addEventListener('submit', handleTeacherFormSubmit);

  ['submissionTaskFilter', 'submissionStudentFilter', 'submissionStatusFilter', 'submissionSearch'].forEach((id) => {
    $(id).addEventListener(id === 'submissionSearch' ? 'input' : 'change', renderTeacherSubmissions);
  });
  ['scoreGradeFilter', 'scoreStudentFilter', 'scoreSearch'].forEach((id) => {
    $(id).addEventListener(id === 'scoreSearch' ? 'input' : 'change', renderScores);
  });

  document.addEventListener('click', handleDynamicClick);
  document.addEventListener('submit', handleDynamicSubmit);
}

async function rpc(name, args = {}) {
  const { data, error } = await state.client.rpc(name, args);
  if (error) throw new Error(error.message || 'Supabase request failed.');
  return data;
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!saved?.session_token || !saved?.role) {
      showLogin();
      return;
    }
    state.session = saved;
    openRoleView(saved.role);
  } catch {
    showLogin();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = normaliseEmail($('loginEmail').value);
  const password = $('loginPassword').value;

  try {
    setBusy(event.submitter, true, 'Logging in...');
    const data = await rpc('app_login', { p_email: email, p_password: password });
    saveSession(data);
    $('loginForm').reset();
    showToast(`Welcome ${data.name || data.email}`);
    await openRoleView(data.role);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(event.submitter, false, 'Login');
  }
}

async function handleLogout() {
  const token = state.session?.session_token;
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
  clearStateData();
  if (token) {
    try { await rpc('app_logout', { p_session_token: token }); } catch { /* ignore */ }
  }
  showLogin();
}

function clearStateData() {
  state.students = [];
  state.teachers = [];
  state.tasks = [];
  state.studentTasks = [];
  state.submissions = [];
  state.selectedStudentTaskId = null;
  state.taskFileQueue = [];
  state.studentFileQueue = [];
  state.signedUrls.clear();
}

function showLogin() {
  $('loginScreen').classList.remove('hidden');
  $('studentScreen').classList.add('hidden');
  $('teacherScreen').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('refreshBtn').classList.add('hidden');
  $('userBadge').classList.add('hidden');
}

async function openRoleView(role) {
  $('loginScreen').classList.add('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('refreshBtn').classList.remove('hidden');
  $('userBadge').classList.remove('hidden');
  $('userBadge').textContent = `${role === 'teacher' ? 'Teacher' : 'Student'}: ${state.session?.name || state.session?.email}`;

  if (role === 'teacher') {
    $('studentScreen').classList.add('hidden');
    $('teacherScreen').classList.remove('hidden');
    $('teacherNameLine').textContent = `Logged in as ${state.session?.name || state.session?.email}. You can view all tasks or only your own tasks.`;
    await loadTeacherData();
  } else {
    $('teacherScreen').classList.add('hidden');
    $('studentScreen').classList.remove('hidden');
    await loadStudentData();
  }
}

async function refreshCurrentView() {
  try {
    state.signedUrls.clear();
    if (state.session?.role === 'teacher') await loadTeacherData();
    if (state.session?.role === 'student') await loadStudentData();
    showToast('Refreshed.');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadTeacherData() {
  const token = state.session.session_token;
  const [students, teachers, tasks, submissions] = await Promise.all([
    rpc('app_teacher_list_students', { p_session_token: token }),
    rpc('app_teacher_list_teachers', { p_session_token: token }),
    rpc('app_teacher_list_tasks', { p_session_token: token }),
    rpc('app_teacher_list_submissions', { p_session_token: token }),
  ]);
  state.students = students || [];
  state.teachers = teachers || [];
  state.tasks = tasks || [];
  state.submissions = submissions || [];

  renderTaskStudentPicker();
  renderTeacherTasks();
  renderStudentsTable();
  renderTeachersTable();
  renderSubmissionFilters();
  renderTeacherSubmissions();
  renderScoreFilters();
  renderScores();
}

async function loadStudentData() {
  const tasks = await rpc('app_student_list_tasks', { p_session_token: state.session.session_token });
  state.studentTasks = tasks || [];
  if (state.selectedStudentTaskId && !state.studentTasks.some((task) => task.id === state.selectedStudentTaskId)) {
    state.selectedStudentTaskId = null;
  }
  renderStudentView();
}

function showTeacherTab(name) {
  document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  document.querySelectorAll('.teacher-tab').forEach((section) => section.classList.add('hidden'));
  $(`teacher${titleCase(name)}Tab`).classList.remove('hidden');
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

// -----------------------------
// Student view
// -----------------------------

function getDisplayStatus(task) {
  return task.display_status || 'open';
}

function statusLabel(status) {
  if (status === 'open') return 'Due / open';
  if (status === 'submitted') return 'Submitted';
  if (status === 'reviewed') return 'Reviewed';
  if (status === 'overdue') return 'Overdue';
  return status;
}

function statusClass(status) {
  return `status-${status}`;
}

function badgeClass(status) {
  return `badge-${status}`;
}

function renderStudentView() {
  renderStudentScoreOverview();
  renderStudentTaskList();
  renderStudentTaskDetail();
}

function renderStudentScoreOverview() {
  const reviewed = state.studentTasks.filter((task) => task.submission?.status === 'reviewed');
  const totalScore = reviewed.reduce((sum, task) => sum + Number(task.submission?.score || 0), 0);
  const totalMax = reviewed.reduce((sum, task) => sum + Number(task.total_score || 0), 0);
  const percent = totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : null;
  const submitted = state.studentTasks.filter((task) => task.submission).length;
  const open = state.studentTasks.filter((task) => getDisplayStatus(task) === 'open' || getDisplayStatus(task) === 'overdue').length;

  $('studentScoreOverview').innerHTML = `
    <div class="score-box"><div class="small muted">Reviewed score</div><div class="num">${escapeHtml(totalScore)} / ${escapeHtml(totalMax)}</div><div class="small">${percent === null ? 'No reviewed tasks yet' : `${percent}% average`}</div></div>
    <div class="score-box"><div class="small muted">Submitted tasks</div><div class="num">${submitted}</div><div class="small">Already sent in</div></div>
    <div class="score-box"><div class="small muted">Still open/due</div><div class="num">${open}</div><div class="small">Need attention</div></div>
    <div class="score-box"><div class="small muted">Total tasks shown</div><div class="num">${state.studentTasks.length}</div><div class="small">For your grade/email</div></div>
  `;
}

function filteredStudentTasks() {
  const search = $('studentSearch').value.trim().toLowerCase();
  const status = $('studentStatusFilter').value;
  return state.studentTasks.filter((task) => {
    const st = getDisplayStatus(task);
    const hay = `${task.title} ${task.subject || ''} ${task.instructions || ''}`.toLowerCase();
    const matchesSearch = !search || hay.includes(search);
    const matchesStatus = status === 'all' || st === status || (status === 'open' && st === 'open');
    return matchesSearch && matchesStatus;
  });
}

function renderStudentTaskList() {
  const tasks = filteredStudentTasks();
  $('studentTaskCount').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  if (!tasks.length) {
    $('studentTasksList').innerHTML = `<div class="empty-state"><h3>No tasks found</h3><p>Change your search/filter.</p></div>`;
    return;
  }
  $('studentTasksList').innerHTML = tasks.map((task) => {
    const status = getDisplayStatus(task);
    const active = task.id === state.selectedStudentTaskId ? 'active' : '';
    const score = task.submission?.status === 'reviewed' ? `${task.submission.score ?? '-'} / ${task.total_score} (${task.submission.percent ?? '-'}%)` : 'Not scored yet';
    return `
      <article class="task-card ${active} ${statusClass(status)}" data-task-id="${escapeHtml(task.id)}">
        <h4>${escapeHtml(task.title)}</h4>
        <div class="meta">
          <span class="badge ${badgeClass(status)}">${statusLabel(status)}</span>
          <span class="badge">${escapeHtml(task.subject || 'No subject')}</span>
          <span class="badge">Due: ${formatDateTime(task.due_at)}</span>
        </div>
        <div class="small"><strong>Score:</strong> ${escapeHtml(score)}</div>
        <div class="actions"><button class="btn btn-sm" type="button" data-open-student-task="${escapeHtml(task.id)}">Open task</button></div>
      </article>
    `;
  }).join('');
}

async function renderStudentTaskDetail() {
  const panel = $('studentTaskPanel');
  const task = state.studentTasks.find((item) => item.id === state.selectedStudentTaskId);
  if (!task) {
    panel.innerHTML = `<div class="empty-state"><h3>Select a task on the left</h3><p>The actual homework task will open here.</p></div>`;
    return;
  }

  const status = getDisplayStatus(task);
  if (!task.submission) { state.studentFileQueue = []; }
  const taskFilesHtml = await renderFileGrid(task.files || [], 'Teacher task files');
  const submission = task.submission;
  let submissionHtml = '';

  if (!submission) {
    submissionHtml = `
      <form id="studentSubmitForm" class="grid no-print" data-task-id="${escapeHtml(task.id)}">
        <label>Your written answer
          <textarea id="studentAnswer" required placeholder="Type your answer here"></textarea>
        </label>
        <div class="grid-2">
          <label>Upload from camera
            <input id="studentCameraInput" type="file" accept="image/*" capture="environment" />
          </label>
          <label>Upload files/images/PDFs
            <input id="studentFilesInput" type="file" multiple accept="image/*,.pdf,.doc,.docx,.txt" />
          </label>
        </div>
        <div id="studentSelectedFiles" class="preview-list local-file-grid"></div>
        <button class="btn" type="submit">Submit task once</button>
        <p class="small muted">After you submit, this task is closed for new submissions.</p>
      </form>
    `;
  } else {
    const submissionFilesHtml = await renderFileGrid(submission.submission_files || [], 'Your uploaded answer files');
    const correctionFilesHtml = await renderFileGrid(submission.correction_files || [], 'Teacher correction files');
    submissionHtml = `
      <div class="panel ${submission.status === 'reviewed' ? 'status-reviewed' : 'status-submitted'}">
        <h3>Your submission</h3>
        <p><span class="badge ${badgeClass(submission.status)}">${statusLabel(submission.status)}</span> ${submission.closed ? '<span class="badge badge-closed">Closed</span>' : ''}</p>
        <p><strong>Submitted:</strong> ${formatDateTime(submission.submitted_at)}</p>
        <div class="instructions"><strong>Your written answer:</strong><br>${escapeHtml(submission.answer || 'No written answer')}</div>
        ${submissionFilesHtml}
        ${submission.status === 'reviewed' ? `
          <hr>
          <h3>Teacher review</h3>
          <p><strong>Score:</strong> ${escapeHtml(submission.score ?? '-')} / ${escapeHtml(task.total_score)} ${submission.percent !== null && submission.percent !== undefined ? `(${escapeHtml(submission.percent)}%)` : ''}</p>
          <div class="instructions"><strong>Feedback:</strong><br>${escapeHtml(submission.feedback || 'No feedback written.')}</div>
          ${correctionFilesHtml}
        ` : '<p class="muted"><strong>Waiting for teacher review.</strong></p>'}
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="homework-title">ACTUAL HOMEWORK TASK</div>
    <article class="task-detail ${statusClass(status)}">
      <div class="btn-row no-print" style="justify-content: space-between; margin-bottom: 10px;">
        <span class="badge ${badgeClass(status)}">${statusLabel(status)}</span>
        <span class="badge">Total: ${escapeHtml(task.total_score)} marks</span>
      </div>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="muted"><strong>${escapeHtml(task.subject || 'No subject')}</strong> • Due: ${formatDateTime(task.due_at)}</p>
      <div class="instructions"><strong>Questions / instructions:</strong><br>${escapeHtml(task.instructions)}</div>
      ${taskFilesHtml}
      <hr>
      ${submissionHtml}
    </article>
  `;

  const cameraInput = $('studentCameraInput');
  const filesInput = $('studentFilesInput');
  if (cameraInput) cameraInput.addEventListener('change', (event) => addFilesToQueue('student', event.target.files));
  if (filesInput) filesInput.addEventListener('change', (event) => addFilesToQueue('student', event.target.files));
}

function renderStudentSelectedFiles() {
  renderQueuedFilesPreview('student');
}

async function handleStudentSubmitForm(form) {
  const taskId = form.dataset.taskId;
  const answer = $('studentAnswer').value.trim();
  const files = [...state.studentFileQueue];
  if (!answer && !files.length) {
    showToast('Type an answer or upload a file before submitting.', true);
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  try {
    setBusy(button, true, 'Submitting...');
    const submission = await rpc('app_student_submit_task', {
      p_session_token: state.session.session_token,
      p_task_id: taskId,
      p_answer: answer,
    });

    for (const file of files) {
      const uploaded = await uploadFile(SUBMISSION_BUCKET, `submissions/${submission.id}`, file);
      await rpc('app_student_add_submission_file', {
        p_session_token: state.session.session_token,
        p_submission_id: submission.id,
        p_bucket: SUBMISSION_BUCKET,
        p_file_path: uploaded.path,
        p_file_name: file.name,
        p_mime_type: file.type || 'application/octet-stream',
        p_size_bytes: file.size,
      });
    }

    state.studentFileQueue = [];
    showToast('Task submitted and closed for new submissions.');
    await loadStudentData();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, 'Submit task once');
  }
}

// -----------------------------
// Teacher tasks
// -----------------------------

function renderTeacherTasks() {
  const owner = $('teacherTaskOwnerFilter').value;
  const search = $('teacherTaskSearch').value.trim().toLowerCase();
  const tasks = state.tasks.filter((task) => {
    const mine = normaliseEmail(task.created_by_email) === normaliseEmail(state.session.email);
    const hay = `${task.title} ${task.subject || ''} ${task.instructions || ''} ${task.created_by_name || ''}`.toLowerCase();
    return (owner === 'all' || mine) && (!search || hay.includes(search));
  });

  if (!tasks.length) {
    $('teacherTasksList').innerHTML = `<div class="empty-state"><h3>No tasks found</h3><p>Add a new task/quiz above.</p></div>`;
    return;
  }

  $('teacherTasksList').innerHTML = tasks.map((task) => `
    <article class="task-card">
      <h4>${escapeHtml(task.title)}</h4>
      <div class="meta">
        <span class="badge">${escapeHtml(task.subject || 'No subject')}</span>
        <span class="badge">Due: ${formatDateTime(task.due_at)}</span>
        <span class="badge">Total: ${escapeHtml(task.total_score)} marks</span>
        <span class="badge">${escapeHtml(allocationLabel(task))}</span>
        <span class="badge">By: ${escapeHtml(task.created_by_name || task.created_by_email || '-')}</span>
        <span class="badge">Submissions: ${escapeHtml(task.submission_count || 0)}</span>
      </div>
      <p class="small muted">${escapeHtml(truncate(task.instructions, 200))}</p>
      <div class="small"><strong>Files:</strong> ${(task.files || []).length ? task.files.map((file) => escapeHtml(file.file_name)).join(', ') : 'None'}</div>
      <div class="actions">
        <button class="btn btn-sm" type="button" data-edit-task="${escapeHtml(task.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" type="button" data-delete-task="${escapeHtml(task.id)}">Safe delete task</button>
      </div>
    </article>
  `).join('');
}


function renderTaskStudentPicker(selectedEmails = null) {
  const picker = $('taskStudentPicker');
  if (!picker) return;
  const selected = new Set((selectedEmails ?? $('taskTargetStudents').value.split(',')).map(normaliseEmail).filter(Boolean));
  if (!state.students.length) {
    picker.innerHTML = `<div class="empty-state compact"><strong>No approved students yet.</strong><br><span class="small muted">Add students first, then select them here.</span></div>`;
    $('taskTargetStudents').value = '';
    return;
  }

  const byGrade = state.students.reduce((acc, student) => {
    const grade = student.grade || 'No grade';
    acc[grade] ||= [];
    acc[grade].push(student);
    return acc;
  }, {});

  picker.innerHTML = Object.keys(byGrade).sort().map((grade) => `
    <div class="student-picker-grade">
      <div class="student-picker-grade-title">${escapeHtml(grade)}</div>
      <div class="student-picker-list">
        ${byGrade[grade].map((student) => {
          const email = normaliseEmail(student.email);
          return `
            <label class="student-check">
              <input type="checkbox" data-task-student-check value="${escapeHtml(email)}" ${selected.has(email) ? 'checked' : ''} />
              <span><strong>${escapeHtml(student.name || email)}</strong><br><small>${escapeHtml(email)}</small></span>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  picker.querySelectorAll('[data-task-student-check]').forEach((box) => {
    box.addEventListener('change', updateTaskTargetStudentsInput);
  });
  updateTaskTargetStudentsInput();
}

function updateTaskTargetStudentsInput() {
  const selected = Array.from(document.querySelectorAll('[data-task-student-check]:checked')).map((box) => normaliseEmail(box.value));
  if ($('taskTargetStudents')) $('taskTargetStudents').value = selected.join(', ');
}

function getSelectedTaskStudentEmails() {
  updateTaskTargetStudentsInput();
  return $('taskTargetStudents').value.split(',').map((email) => normaliseEmail(email)).filter(Boolean);
}

function allocationLabel(task) {
  if (task.allocation_type === 'all') return 'All students';
  if (task.allocation_type === 'grade') return `Grade: ${task.target_grade || '-'}`;
  if (task.allocation_type === 'students') return `Students: ${(task.target_student_emails || []).length}`;
  if (task.allocation_type === 'grade_students') return `Grade + students`;
  return task.allocation_type;
}

async function handleTaskFormSubmit(event) {
  event.preventDefault();
  const button = event.submitter;
  const taskId = $('taskIdInput').value || null;
  const targetStudents = getSelectedTaskStudentEmails();
  const dueAt = $('taskDueAt').value ? new Date($('taskDueAt').value).toISOString() : null;
  const files = [...state.taskFileQueue];

  try {
    setBusy(button, true, 'Saving...');
    const task = await rpc('app_teacher_upsert_task', {
      p_session_token: state.session.session_token,
      p_task_id: taskId,
      p_title: $('taskTitle').value,
      p_subject: $('taskSubject').value,
      p_instructions: $('taskInstructions').value,
      p_due_at: dueAt,
      p_total_score: Number($('taskTotalScore').value || 0),
      p_allocation_type: $('taskAllocationType').value,
      p_target_grade: $('taskTargetGrade').value,
      p_target_student_emails: targetStudents,
      p_active: true,
    });

    for (const file of files) {
      const uploaded = await uploadFile(TASK_BUCKET, `tasks/${task.id}`, file);
      await rpc('app_teacher_add_task_file', {
        p_session_token: state.session.session_token,
        p_task_id: task.id,
        p_bucket: TASK_BUCKET,
        p_file_path: uploaded.path,
        p_file_name: file.name,
        p_mime_type: file.type || 'application/octet-stream',
        p_size_bytes: file.size,
      });
    }

    clearTaskForm();
    showToast(taskId ? 'Task updated.' : 'Task created.');
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, 'Save Task / Quiz');
  }
}

function editTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  $('taskFormTitle').textContent = 'Edit Task / Quiz';
  $('taskIdInput').value = task.id;
  $('taskTitle').value = task.title || '';
  $('taskSubject').value = task.subject || '';
  $('taskInstructions').value = task.instructions || '';
  $('taskDueAt').value = toLocalInputDateTime(task.due_at);
  $('taskTotalScore').value = task.total_score ?? 0;
  $('taskAllocationType').value = task.allocation_type || 'all';
  $('taskTargetGrade').value = task.target_grade || '';
  $('taskTargetStudents').value = (task.target_student_emails || []).join(', ');
  state.taskFileQueue = [];
  $('taskFilesInput').value = '';
  renderQueuedFilesPreview('task');
  renderTaskStudentPicker(task.target_student_emails || []);
  if ((task.files || []).length) {
    $('taskFilesPreview').insertAdjacentHTML('afterbegin', `<p class="small muted"><strong>Already saved files:</strong> ${(task.files || []).map((file) => escapeHtml(file.file_name)).join(', ')}. Select more files to add them.</p>`);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearTaskForm() {
  $('taskFormTitle').textContent = 'Add New Task / Quiz';
  $('taskForm').reset();
  $('taskIdInput').value = '';
  $('taskTotalScore').value = 10;
  $('taskTargetStudents').value = '';
  state.taskFileQueue = [];
  $('taskFilesInput').value = '';
  renderQueuedFilesPreview('task');
  renderTaskStudentPicker();
}

async function deleteTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const ok = confirm(`Delete this task/quiz and all its submissions/files?\n\n${task.title}\n\nThis helps save Supabase space but cannot be undone.`);
  if (!ok) return;

  try {
    const deleted = await rpc('app_teacher_delete_task', { p_session_token: state.session.session_token, p_task_id: taskId });
    await removeFilesFromDeleteResult(deleted);
    showToast('Task, submissions, and files deleted.');
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  }
}

// -----------------------------
// Teacher students and teachers
// -----------------------------

async function handleStudentFormSubmit(event) {
  event.preventDefault();
  const button = event.submitter;
  try {
    setBusy(button, true, 'Saving...');
    await rpc('app_teacher_upsert_student', {
      p_session_token: state.session.session_token,
      p_email: $('studentEmail').value,
      p_name: $('studentName').value,
      p_grade: $('studentGrade').value,
      p_password: $('studentPassword').value,
      p_active: $('studentActive').value === 'true',
    });
    $('studentForm').reset();
    $('studentActive').value = 'true';
    showToast('Student saved.');
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, 'Save Student');
  }
}

function renderStudentsTable() {
  if (!state.students.length) {
    $('studentsTable').innerHTML = `<div class="empty-state"><h3>No students yet</h3></div>`;
    return;
  }
  $('studentsTable').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Grade</th><th>Status</th><th>Password saved</th><th>Action</th></tr></thead>
      <tbody>${state.students.map((s) => `
        <tr>
          <td>${escapeHtml(s.name || '-')}</td>
          <td>${escapeHtml(s.email)}</td>
          <td>${escapeHtml(s.grade || '-')}</td>
          <td>${s.active ? '<span class="badge badge-reviewed">Active</span>' : '<span class="badge badge-closed">Inactive</span>'}</td>
          <td>${s.has_password ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-sm btn-ghost" type="button" data-edit-student="${escapeHtml(s.email)}">Edit</button></td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

function editStudent(email) {
  const s = state.students.find((item) => item.email === email);
  if (!s) return;
  $('studentEmail').value = s.email;
  $('studentName').value = s.name || '';
  $('studentGrade').value = s.grade || '';
  $('studentPassword').value = '';
  $('studentActive').value = String(Boolean(s.active));
  showTeacherTab('students');
  $('studentEmail').focus();
}

async function handleTeacherFormSubmit(event) {
  event.preventDefault();
  const button = event.submitter;
  try {
    setBusy(button, true, 'Saving...');
    await rpc('app_teacher_upsert_teacher', {
      p_session_token: state.session.session_token,
      p_email: $('teacherEmail').value,
      p_name: $('teacherName').value,
      p_password: $('teacherPassword').value,
      p_active: $('teacherActive').value === 'true',
    });
    $('teacherForm').reset();
    $('teacherActive').value = 'true';
    showToast('Teacher saved.');
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, 'Save Teacher');
  }
}

function renderTeachersTable() {
  if (!state.teachers.length) {
    $('teachersTable').innerHTML = `<div class="empty-state"><h3>No teachers yet</h3></div>`;
    return;
  }
  $('teachersTable').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Password saved</th><th>Action</th></tr></thead>
      <tbody>${state.teachers.map((t) => `
        <tr>
          <td>${escapeHtml(t.name || '-')}</td>
          <td>${escapeHtml(t.email)}</td>
          <td>${t.active ? '<span class="badge badge-reviewed">Active</span>' : '<span class="badge badge-closed">Inactive</span>'}</td>
          <td>${t.has_password ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-sm btn-ghost" type="button" data-edit-teacher="${escapeHtml(t.email)}">Edit</button></td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

function editTeacher(email) {
  const t = state.teachers.find((item) => item.email === email);
  if (!t) return;
  $('teacherEmail').value = t.email;
  $('teacherName').value = t.name || '';
  $('teacherPassword').value = '';
  $('teacherActive').value = String(Boolean(t.active));
  showTeacherTab('teachers');
  $('teacherEmail').focus();
}

// -----------------------------
// Teacher submissions/review/export/delete
// -----------------------------

function renderSubmissionFilters() {
  const taskOptions = state.tasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)}</option>`).join('');
  $('submissionTaskFilter').innerHTML = `<option value="all">All tasks</option>${taskOptions}`;

  const studentOptions = state.students.map((s) => `<option value="${escapeHtml(s.email)}">${escapeHtml(s.name || s.email)} (${escapeHtml(s.grade || '-')})</option>`).join('');
  $('submissionStudentFilter').innerHTML = `<option value="all">All students</option>${studentOptions}`;
}

function filteredSubmissions() {
  const taskId = $('submissionTaskFilter').value;
  const studentEmail = $('submissionStudentFilter').value;
  const status = $('submissionStatusFilter').value;
  const search = $('submissionSearch').value.trim().toLowerCase();

  return state.submissions.filter((sub) => {
    const hay = `${sub.task_title} ${sub.subject || ''} ${sub.student_email} ${sub.student_name || ''} ${sub.answer || ''}`.toLowerCase();
    return (taskId === 'all' || sub.task_id === taskId)
      && (studentEmail === 'all' || sub.student_email === studentEmail)
      && (status === 'all' || sub.status === status)
      && (!search || hay.includes(search));
  });
}

async function renderTeacherSubmissions() {
  const subs = filteredSubmissions();
  if (!subs.length) {
    $('submissionsList').innerHTML = `<div class="panel empty-state"><h3>No submissions found</h3><p>Try another filter.</p></div>`;
    return;
  }

  const parts = [];
  for (const sub of subs) {
    parts.push(await submissionCardHtml(sub));
  }
  $('submissionsList').innerHTML = parts.join('');
}

async function submissionCardHtml(sub) {
  const taskFiles = await renderFileGrid(sub.task_files || [], 'Teacher question/task files');
  const submissionFiles = await renderFileGrid(sub.submission_files || [], 'Student answer files');
  const correctionFiles = await renderFileGrid(sub.correction_files || [], 'Teacher correction files');
  const closed = sub.closed ? '<span class="badge badge-closed">Closed</span>' : '';
  return `
    <article class="panel panel-black ${sub.status === 'reviewed' ? 'status-reviewed' : 'status-submitted'}">
      <div class="panel-headline">
        <h3>${escapeHtml(sub.task_title)}</h3>
        <div class="btn-row no-print">
          <span class="badge ${badgeClass(sub.status)}">${statusLabel(sub.status)}</span>
          ${closed}
          <button class="btn btn-sm btn-ghost" type="button" data-export-submission="${escapeHtml(sub.id)}">Preview / Export PDF</button>
          <button class="btn btn-danger btn-sm" type="button" data-delete-submission="${escapeHtml(sub.id)}">Safe delete submission</button>
        </div>
      </div>
      <div class="grid-3">
        <p><strong>Student:</strong><br>${escapeHtml(sub.student_name || '-')}<br><span class="small muted">${escapeHtml(sub.student_email)}</span></p>
        <p><strong>Grade:</strong><br>${escapeHtml(sub.student_grade || '-')}</p>
        <p><strong>Score:</strong><br>${escapeHtml(sub.score ?? '-')} / ${escapeHtml(sub.total_score)} ${sub.percent !== null && sub.percent !== undefined ? `(${escapeHtml(sub.percent)}%)` : ''}</p>
      </div>
      <p><strong>Submitted:</strong> ${formatDateTime(sub.submitted_at)} • <strong>Due:</strong> ${formatDateTime(sub.due_at)}</p>
      <div class="instructions"><strong>Teacher questions/instructions:</strong><br>${escapeHtml(sub.task_instructions || '')}</div>
      ${taskFiles}
      <div class="instructions"><strong>Student written answer:</strong><br>${escapeHtml(sub.answer || 'No written answer')}</div>
      ${submissionFiles}
      <form class="reviewForm grid no-print" data-submission-id="${escapeHtml(sub.id)}">
        <div class="grid-3">
          <label>Score out of ${escapeHtml(sub.total_score)}
            <input name="score" type="number" min="0" max="${escapeHtml(sub.total_score)}" step="0.5" value="${escapeHtml(sub.score ?? '')}" />
          </label>
          <label>Upload corrections/files
            <input name="correctionFiles" type="file" multiple accept="image/*,.pdf,.doc,.docx,.txt" />
          </label>
          <label>Status after review
            <input value="Reviewed and closed" disabled />
          </label>
        </div>
        <label>Teacher feedback
          <textarea name="feedback" placeholder="Write feedback/corrections here">${escapeHtml(sub.feedback || '')}</textarea>
        </label>
        <div class="btn-row">
          <button class="btn" type="submit">Save review and close</button>
          <span class="small muted">Once reviewed, this submission is closed for this student/task.</span>
        </div>
      </form>
      ${correctionFiles}
    </article>
  `;
}

async function handleReviewSubmit(form) {
  const submissionId = form.dataset.submissionId;
  const sub = state.submissions.find((item) => item.id === submissionId);
  const button = form.querySelector('button[type="submit"]');
  const score = form.elements.score.value === '' ? null : Number(form.elements.score.value);
  const feedback = form.elements.feedback.value;
  const files = Array.from(form.elements.correctionFiles.files || []);

  try {
    setBusy(button, true, 'Saving review...');
    await rpc('app_teacher_review_submission', {
      p_session_token: state.session.session_token,
      p_submission_id: submissionId,
      p_score: score,
      p_feedback: feedback,
    });

    for (const file of files) {
      const uploaded = await uploadFile(CORRECTION_BUCKET, `corrections/${submissionId}`, file);
      await rpc('app_teacher_add_correction_file', {
        p_session_token: state.session.session_token,
        p_submission_id: submissionId,
        p_bucket: CORRECTION_BUCKET,
        p_file_path: uploaded.path,
        p_file_name: file.name,
        p_mime_type: file.type || 'application/octet-stream',
        p_size_bytes: file.size,
      });
    }

    showToast(`Reviewed and closed: ${sub?.student_name || sub?.student_email || 'submission'}`);
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, 'Save review and close');
  }
}

async function deleteSubmission(submissionId) {
  const sub = state.submissions.find((item) => item.id === submissionId);
  if (!sub) return;
  const ok = confirm(`Delete this submission and its files?\n\nStudent: ${sub.student_name || sub.student_email}\nTask: ${sub.task_title}\n\nThis helps save Supabase space but cannot be undone.`);
  if (!ok) return;

  try {
    const deleted = await rpc('app_teacher_delete_submission', { p_session_token: state.session.session_token, p_submission_id: submissionId });
    await removeFilesFromDeleteResult(deleted);
    showToast('Submission and files deleted.');
    await loadTeacherData();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function openExportModal(submissionId) {
  const sub = state.submissions.find((item) => item.id === submissionId);
  if (!sub) return;
  const taskFiles = await renderFileGrid(sub.task_files || [], 'Question/task files', true);
  const submissionFiles = await renderFileGrid(sub.submission_files || [], 'Student answer files', true);
  const correctionFiles = await renderFileGrid(sub.correction_files || [], 'Teacher correction files', true);
  const filename = makePdfName(sub);

  $('modalRoot').className = 'modal-backdrop';
  $('modalRoot').innerHTML = `
    <div class="modal">
      <div class="modal-head no-print">
        <h3>PDF Preview: ${escapeHtml(filename)}</h3>
        <div class="btn-row">
          <button class="btn" type="button" data-print-title="${escapeHtml(filename)}">Print / Save as PDF</button>
          <button class="btn btn-ghost" type="button" data-close-modal>Close</button>
        </div>
      </div>
      <div class="print-area">
        <div class="print-cover">
          <h1>SNT Homework Submission</h1>
          <p><strong>Student:</strong> ${escapeHtml(sub.student_name || '-')} (${escapeHtml(sub.student_email)})</p>
          <p><strong>Grade:</strong> ${escapeHtml(sub.student_grade || '-')}</p>
          <p><strong>Task:</strong> ${escapeHtml(sub.task_title)}</p>
          <p><strong>Subject/group:</strong> ${escapeHtml(sub.subject || '-')}</p>
          <p><strong>Submitted:</strong> ${formatDateTime(sub.submitted_at)}</p>
          <p><strong>Status:</strong> ${escapeHtml(statusLabel(sub.status))} ${sub.closed ? '• Closed' : ''}</p>
          <p><strong>Score:</strong> ${escapeHtml(sub.score ?? '-')} / ${escapeHtml(sub.total_score)} ${sub.percent !== null && sub.percent !== undefined ? `(${escapeHtml(sub.percent)}%)` : ''}</p>
        </div>
        <section class="print-section">
          <h3>1. Teacher questions / task text</h3>
          <div class="instructions">${escapeHtml(sub.task_instructions || '')}</div>
          ${taskFiles}
        </section>
        <section class="print-section">
          <h3>2. Student written answer</h3>
          <div class="instructions">${escapeHtml(sub.answer || 'No written answer')}</div>
        </section>
        <section class="print-section">
          <h3>3. Student uploaded files</h3>
          ${submissionFiles}
        </section>
        <section class="print-section">
          <h3>4. Teacher review</h3>
          <p><strong>Reviewed by:</strong> ${escapeHtml(sub.reviewed_by_name || sub.reviewed_by_email || '-')}</p>
          <p><strong>Reviewed at:</strong> ${formatDateTime(sub.reviewed_at)}</p>
          <div class="instructions"><strong>Feedback:</strong><br>${escapeHtml(sub.feedback || 'No feedback written.')}</div>
          ${correctionFiles}
        </section>
      </div>
    </div>
  `;
}

function makePdfName(sub) {
  const date = new Date(sub.submitted_at || Date.now()).toISOString().slice(0, 10);
  return safeFileName(`SNT_${sub.student_name || sub.student_email}_${sub.task_title}_${date}`).replace(/\.[a-z0-9]+$/i, '');
}

// -----------------------------
// Scores
// -----------------------------

function renderScoreFilters() {
  const grades = [...new Set(state.students.map((s) => s.grade).filter(Boolean))].sort();
  $('scoreGradeFilter').innerHTML = `<option value="all">All grades</option>${grades.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}`;
  $('scoreStudentFilter').innerHTML = `<option value="all">All students</option>${state.students.map((s) => `<option value="${escapeHtml(s.email)}">${escapeHtml(s.name || s.email)}</option>`).join('')}`;
}

function taskAssignedToStudent(task, student) {
  const grade = String(student.grade || '').toLowerCase();
  const email = normaliseEmail(student.email);
  if (!task.active) return false;
  if (task.allocation_type === 'all') return true;
  if (task.allocation_type === 'grade') return String(task.target_grade || '').toLowerCase() === grade;
  if (task.allocation_type === 'students') return (task.target_student_emails || []).map(normaliseEmail).includes(email);
  if (task.allocation_type === 'grade_students') return String(task.target_grade || '').toLowerCase() === grade || (task.target_student_emails || []).map(normaliseEmail).includes(email);
  return false;
}

function renderScores() {
  const gradeFilter = $('scoreGradeFilter').value;
  const studentFilter = $('scoreStudentFilter').value;
  const search = $('scoreSearch').value.trim().toLowerCase();

  const students = state.students.filter((student) => {
    const hay = `${student.name || ''} ${student.email} ${student.grade || ''}`.toLowerCase();
    return (gradeFilter === 'all' || student.grade === gradeFilter)
      && (studentFilter === 'all' || student.email === studentFilter)
      && (!search || hay.includes(search));
  });

  if (!students.length) {
    $('scoresTable').innerHTML = `<div class="empty-state"><h3>No scores found</h3></div>`;
    return;
  }

  const rows = [];
  for (const student of students) {
    const assignedTasks = state.tasks.filter((task) => taskAssignedToStudent(task, student));
    let studentScore = 0;
    let studentMax = 0;
    for (const task of assignedTasks) {
      const sub = state.submissions.find((item) => item.task_id === task.id && item.student_email === student.email);
      const score = sub?.score;
      const max = Number(task.total_score || 0);
      if (sub?.status === 'reviewed' && score !== null && score !== undefined) {
        studentScore += Number(score || 0);
        studentMax += max;
      }
      rows.push({ student, task, sub, score, max, isTotal: false });
    }
    rows.push({ student, task: null, sub: null, score: studentScore, max: studentMax, isTotal: true });
  }

  $('scoresTable').innerHTML = `
    <table>
      <thead><tr><th>Student</th><th>Grade</th><th>Task</th><th>Status</th><th>Score</th><th>%</th></tr></thead>
      <tbody>${rows.map((row) => {
        if (row.isTotal) {
          const percent = row.max > 0 ? Math.round((row.score / row.max) * 1000) / 10 : '-';
          return `<tr><td><strong>${escapeHtml(row.student.name || row.student.email)}</strong></td><td>${escapeHtml(row.student.grade || '-')}</td><td><strong>TOTAL REVIEWED</strong></td><td>-</td><td><strong>${escapeHtml(row.score)} / ${escapeHtml(row.max)}</strong></td><td><strong>${escapeHtml(percent)}${percent === '-' ? '' : '%'}</strong></td></tr>`;
        }
        const status = row.sub?.status || (row.task.due_at && new Date(row.task.due_at) < new Date() ? 'overdue' : 'open');
        const percent = row.sub?.percent ?? '-';
        return `<tr><td>${escapeHtml(row.student.name || row.student.email)}</td><td>${escapeHtml(row.student.grade || '-')}</td><td>${escapeHtml(row.task.title)}</td><td><span class="badge ${badgeClass(status)}">${escapeHtml(statusLabel(status))}</span></td><td>${row.sub?.score ?? '-'} / ${escapeHtml(row.max)}</td><td>${escapeHtml(percent)}${percent === '-' ? '' : '%'}</td></tr>`;
      }).join('')}</tbody>
    </table>
  `;
}

// -----------------------------
// Dynamic events
// -----------------------------

async function handleDynamicClick(event) {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.openStudentTask) {
    state.selectedStudentTaskId = target.dataset.openStudentTask;
    state.studentFileQueue = [];
    renderStudentView();
  }
  if (target.dataset.removeQueuedFile) {
    const [kind, indexText] = target.dataset.removeQueuedFile.split(':');
    const index = Number(indexText);
    if (kind === 'task') state.taskFileQueue.splice(index, 1);
    if (kind === 'student') state.studentFileQueue.splice(index, 1);
    renderQueuedFilesPreview(kind);
  }
  if (target.dataset.editTask) editTask(target.dataset.editTask);
  if (target.dataset.deleteTask) await deleteTask(target.dataset.deleteTask);
  if (target.dataset.editStudent) editStudent(target.dataset.editStudent);
  if (target.dataset.editTeacher) editTeacher(target.dataset.editTeacher);
  if (target.dataset.deleteSubmission) await deleteSubmission(target.dataset.deleteSubmission);
  if (target.dataset.exportSubmission) await openExportModal(target.dataset.exportSubmission);
  if (target.dataset.closeModal !== undefined) closeModal();
  if (target.dataset.pdfViewFull) await handleViewFullPdf(target);
  if (target.dataset.printTitle) printWithTitle(target.dataset.printTitle);
}

async function handleDynamicSubmit(event) {
  if (event.target.id === 'studentSubmitForm') {
    event.preventDefault();
    await handleStudentSubmitForm(event.target);
  }
  if (event.target.classList.contains('reviewForm')) {
    event.preventDefault();
    await handleReviewSubmit(event.target);
  }
}

function closeModal() {
  $('modalRoot').className = 'hidden';
  $('modalRoot').innerHTML = '';
}

function printWithTitle(title) {
  const old = document.title;
  document.title = title || 'SNT_Submission';
  window.print();
  setTimeout(() => { document.title = old; }, 800);
}

// -----------------------------
// Files and previews
// -----------------------------

async function uploadFile(bucket, folder, file) {
  const path = `${folder}/${Date.now()}-${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { data, error } = await state.client.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if (error) throw new Error(`Upload failed for ${file.name}: ${error.message}`);
  return data;
}

function safeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function addFilesToQueue(kind, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const queue = kind === 'task' ? state.taskFileQueue : state.studentFileQueue;
  for (const file of files) queue.push(file);
  if (kind === 'task') $('taskFilesInput').value = '';
  if (kind === 'student') {
    if ($('studentCameraInput')) $('studentCameraInput').value = '';
    if ($('studentFilesInput')) $('studentFilesInput').value = '';
  }
  renderQueuedFilesPreview(kind);
}

function renderQueuedFilesPreview(kind) {
  const queue = kind === 'task' ? state.taskFileQueue : state.studentFileQueue;
  const output = kind === 'task' ? $('taskFilesPreview') : $('studentSelectedFiles');
  if (!output) return;
  if (!queue.length) {
    output.innerHTML = '';
    return;
  }
  output.innerHTML = `
    <div class="queued-files-note"><strong>${queue.length} selected file${queue.length === 1 ? '' : 's'}</strong> — these will upload when you save/submit.</div>
    <div class="file-grid local-file-grid">
      ${queue.map((file, index) => localFileCardHtml(file, kind, index)).join('')}
    </div>
  `;
}

function localFileCardHtml(file, kind, index) {
  const url = URL.createObjectURL(file);
  const type = file.type || guessMimeType(file.name);
  const isPdf = isPdfFile({ file_name: file.name, mime_type: type });
  let preview = `<div class="file-placeholder">Preview not available for this file type.</div>`;
  if (isImageFile({ file_name: file.name, mime_type: type })) {
    preview = `<img src="${escapeHtml(url)}" alt="${escapeHtml(file.name)}" loading="lazy" />`;
  } else if (isPdf) {
    preview = pdfViewerHtml(url, file.name, true);
  }
  return `
    <div class="file-card local-file-card">
      <div class="file-card-head">
        <strong>${escapeHtml(file.name)}</strong>
        <button class="btn btn-danger btn-sm" type="button" data-remove-queued-file="${escapeHtml(kind)}:${index}">Remove</button>
      </div>
      <span class="small muted">${escapeHtml(type || 'file')} • ${formatBytes(file.size)}</span>
      <div class="file-preview file-preview-large ${isPdf ? 'pdf-preview-wrap' : ''}">${preview}</div>
    </div>
  `;
}

async function signUrl(file) {
  const key = `${file.bucket}/${file.file_path}`;
  if (state.signedUrls.has(key)) return state.signedUrls.get(key);
  const { data, error } = await state.client.storage.from(file.bucket).createSignedUrl(file.file_path, 60 * 60);
  if (error) {
    console.warn('Could not sign URL', error);
    return null;
  }
  state.signedUrls.set(key, data.signedUrl);
  return data.signedUrl;
}

function guessMimeType(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.txt')) return 'text/plain';
  return '';
}

function isPdfFile(file) {
  const type = String(file?.mime_type || '').toLowerCase();
  const name = String(file?.file_name || file?.file_path || '').toLowerCase();
  return type.includes('pdf') || name.endsWith('.pdf');
}

function isImageFile(file) {
  const type = String(file?.mime_type || '').toLowerCase();
  const name = String(file?.file_name || file?.file_path || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function setupPdfJs() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
}

let pdfPreviewTimer = null;
function startPdfPreviewObserver() {
  const observer = new MutationObserver(() => schedulePdfPreviewInit());
  observer.observe(document.body, { childList: true, subtree: true });
  schedulePdfPreviewInit();
}

function schedulePdfPreviewInit() {
  clearTimeout(pdfPreviewTimer);
  pdfPreviewTimer = setTimeout(() => initialisePdfPreviews(), 80);
}

function pdfViewerHtml(url, name, printable = false) {
  const safeUrl = escapeHtml(url || '');
  const safeName = escapeHtml(name || 'PDF file');
  return `
    <div class="pdfjs-viewer" data-pdf-url="${safeUrl}" data-pdf-name="${safeName}" data-printable="${printable ? 'true' : 'false'}">
      <div class="pdfjs-toolbar no-print">
        <span class="pdfjs-title">PDF preview</span>
        <button class="btn btn-sm" type="button" data-pdf-view-full>View full PDF</button>
        <a class="btn btn-ghost btn-sm" href="${safeUrl}" target="_blank" rel="noopener">Open PDF</a>
        <a class="btn btn-ghost btn-sm" href="${safeUrl}" download="${safeName}">Download PDF</a>
      </div>
      <div class="pdfjs-status small muted">Loading first page preview…</div>
      <div class="pdfjs-pages" aria-label="PDF preview pages"></div>
      <noscript><div class="file-placeholder">Preview not available on this device. Tap Open PDF.</div></noscript>
    </div>
  `;
}

async function initialisePdfPreviews() {
  const viewers = Array.from(document.querySelectorAll('.pdfjs-viewer:not([data-pdf-state])'));
  for (const viewer of viewers) {
    viewer.dataset.pdfState = 'loading';
    renderPdfPreview(viewer, 1).catch((err) => showPdfPreviewError(viewer, err));
    await wait(30);
  }
}

async function renderPdfPreview(viewer, pageLimit = 1) {
  const url = viewer.dataset.pdfUrl;
  if (!url || !window.pdfjsLib) {
    throw new Error('PDF.js is not available on this device.');
  }

  const status = viewer.querySelector('.pdfjs-status');
  const pagesEl = viewer.querySelector('.pdfjs-pages');
  pagesEl.innerHTML = '';
  status.textContent = pageLimit === 1 ? 'Loading first page preview…' : 'Loading full PDF slowly…';

  const loadingTask = window.pdfjsLib.getDocument({
    url,
    disableAutoFetch: pageLimit === 1,
    disableStream: false,
    withCredentials: false,
  });
  const pdf = await loadingTask.promise;
  viewer.__pdfDocument = pdf;
  const totalPages = pdf.numPages || 1;
  const pagesToRender = Math.min(pageLimit === 'all' ? totalPages : pageLimit, totalPages);

  for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
    status.textContent = pageLimit === 1
      ? `Showing page 1 of ${totalPages}.`
      : `Loading page ${pageNumber} of ${totalPages}…`;
    await renderPdfPage(pdf, pageNumber, pagesEl);
    await wait(PDF_PAGE_DELAY_MS);
  }

  status.textContent = pagesToRender >= totalPages
    ? `Full PDF loaded: ${totalPages} page${totalPages === 1 ? '' : 's'}.`
    : `Showing first page of ${totalPages}. Tap “View full PDF” to load all pages.`;
  viewer.dataset.pdfState = pagesToRender >= totalPages ? 'full' : 'first-page';
}

async function renderPdfPage(pdf, pageNumber, pagesEl) {
  const page = await pdf.getPage(pageNumber);
  const containerWidth = Math.max(280, Math.min(980, pagesEl.clientWidth || pagesEl.closest('.file-preview')?.clientWidth || 640));
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.max(0.45, (containerWidth - 22) / baseViewport.width));
  const viewport = page.getViewport({ scale });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  const pageWrap = document.createElement('div');
  pageWrap.className = 'pdfjs-page-wrap';

  const label = document.createElement('div');
  label.className = 'pdfjs-page-label small muted';
  label.textContent = `Page ${pageNumber}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'pdfjs-canvas';
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  pageWrap.appendChild(label);
  pageWrap.appendChild(canvas);
  pagesEl.appendChild(pageWrap);

  const context = canvas.getContext('2d', { alpha: false });
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
}

async function handleViewFullPdf(button) {
  const viewer = button.closest('.pdfjs-viewer');
  if (!viewer || viewer.dataset.pdfState === 'full') return;
  const oldText = button.textContent;
  try {
    setBusy(button, true, 'Loading pages…');
    await renderPdfPreview(viewer, 'all');
  } catch (err) {
    showPdfPreviewError(viewer, err);
  } finally {
    setBusy(button, false, oldText);
  }
}

function showPdfPreviewError(viewer, err) {
  console.warn('PDF preview failed', err);
  viewer.dataset.pdfState = 'error';
  const status = viewer.querySelector('.pdfjs-status');
  const pagesEl = viewer.querySelector('.pdfjs-pages');
  if (status) status.textContent = 'Preview not available on this device. Tap Open PDF.';
  if (pagesEl) {
    pagesEl.innerHTML = '<div class="file-placeholder">Preview not available on this device. Tap Open PDF.</div>';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderFileGrid(files, title = 'Files', printable = false) {
  if (!files || !files.length) return `<p class="muted small">No ${escapeHtml(title.toLowerCase())}.</p>`;
  const cards = [];
  for (const file of files) {
    const url = await signUrl(file);
    const type = file.mime_type || guessMimeType(file.file_name || file.file_path || '');
    const name = file.file_name || 'file';
    const isPdf = url && isPdfFile({ file_name: name, mime_type: type, file_path: file.file_path });
    let preview = `<div class="file-placeholder">Preview not available for this file type.${url ? `<br><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open file</a>` : ''}</div>`;
    let actionHtml = url ? `<a class="btn btn-ghost btn-sm no-print" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open full file</a>` : '';
    if (url && isImageFile({ file_name: name, mime_type: type, file_path: file.file_path })) {
      preview = `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" />`;
    } else if (isPdf) {
      preview = pdfViewerHtml(url, name, printable);
      actionHtml = '';
    }
    cards.push(`
      <div class="file-card">
        <strong>${escapeHtml(name)}</strong>
        <span class="small muted">${escapeHtml(type || 'file')} • ${formatBytes(file.size_bytes)}</span>
        <div class="file-preview file-preview-large ${isPdf ? 'pdf-preview-wrap' : ''}">${preview}</div>
        ${actionHtml}
      </div>
    `);
  }
  return `<section class="grid"><h3>${escapeHtml(title)}</h3><div class="file-grid ${printable ? 'print-file-grid' : ''}">${cards.join('')}</div></section>`;
}

async function removeFilesFromDeleteResult(deleted) {
  const all = [
    ...(deleted?.task_files || []),
    ...(deleted?.submission_files || []),
    ...(deleted?.correction_files || []),
  ].filter((file) => file?.bucket && file?.file_path);
  if (!all.length) return;
  const byBucket = all.reduce((acc, file) => {
    acc[file.bucket] ||= [];
    acc[file.bucket].push(file.file_path);
    return acc;
  }, {});
  for (const [bucket, paths] of Object.entries(byBucket)) {
    const { error } = await state.client.storage.from(bucket).remove(paths);
    if (error) console.warn('Storage delete warning:', error.message);
  }
}

// -----------------------------
// Utilities
// -----------------------------

function formatDateTime(value) {
  if (!value) return 'No due date';
  try {
    return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function toLocalInputDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(size >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = busy ? label : label;
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', Boolean(isError));
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), isError ? 6500 : 3500);
}
