const app = {
  meta: null,
  role: localStorage.getItem('pwd_role') || 'JE',
  
  async init() {
    try {
      const res = await fetch('/api/meta');
      this.meta = await res.json();
      
      const select = document.getElementById('role-select');
      for (const [id, r] of Object.entries(this.meta.roles)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = r.label;
        select.appendChild(opt);
      }
      select.value = this.role;
      select.addEventListener('change', (e) => {
        this.role = e.target.value;
        localStorage.setItem('pwd_role', this.role);
        this.renderCurrentView();
      });
      document.getElementById('rolebox').style.display = 'flex';
      
      document.getElementById('nav-projects').addEventListener('click', (e) => {
        e.preventDefault();
        this.navigate('projects');
      });
      
      this.navigate('projects');
    } catch (e) {
      this.toast('Failed to load app data', true);
    }
  },

  toast(msg, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' danger' : '');
    setTimeout(() => el.classList.remove('show'), 3000);
  },

  currentView: 'projects',
  currentParams: null,

  navigate(view, params = null) {
    this.currentView = view;
    this.currentParams = params;
    this.renderCurrentView();
  },

  renderCurrentView() {
    const root = document.getElementById('app-root');
    root.innerHTML = '';
    
    if (this.currentView === 'projects') this.renderProjects(root);
    else if (this.currentView === 'new-dpr') this.renderNewDpr(root);
    else if (this.currentView === 'project') this.renderProjectDetail(root, this.currentParams.id);
  },

  async renderProjects(root) {
    const tpl = document.getElementById('tpl-projects').content.cloneNode(true);
    root.appendChild(tpl);
    
    const btnNew = document.getElementById('btn-new-project');
    if (this.role !== 'JE') {
      document.getElementById('btn-new-project-container').style.display = 'none';
    } else {
      btnNew.addEventListener('click', () => this.navigate('new-dpr'));
    }

    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      const tbody = document.querySelector('#projects-table tbody');
      
      if (data.projects.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">No projects found</td></tr>';
        return;
      }

      data.projects.forEach(p => {
        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.onclick = () => this.navigate('project', { id: p.id });
        
        const pillClass = p.overdue ? 'danger' : (p.current_stage === 'PAYMENT_TRIGGERED' ? 'ok' : 'muted');
        const timeText = p.current_stage === 'PAYMENT_TRIGGERED' ? 'Done' : `${p.days_in_stage} days`;
        
        tr.innerHTML = `
          <td><span class="mono">${p.code}</span></td>
          <td style="font-weight:500">${p.title}</td>
          <td><span class="pill ${pillClass}">${p.stage_label}</span></td>
          <td class="muted">${p.waiting_on ? this.meta.roles[p.waiting_on].short : '-'}</td>
          <td class="${p.overdue ? 'danger' : ''}">${timeText}${p.overdue ? ' (Overdue)' : ''}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      this.toast('Failed to load projects', true);
    }
  },

  async renderNewDpr(root) {
    const tpl = document.getElementById('tpl-new-dpr').content.cloneNode(true);
    root.appendChild(tpl);
    
    document.getElementById('new-dpr-back').onclick = (e) => { e.preventDefault(); this.navigate('projects'); };

    const deptSelect = document.getElementById('dpr-dept');
    this.meta.departments.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      deptSelect.appendChild(opt);
    });

    document.getElementById('form-new-dpr').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        title: document.getElementById('dpr-title').value,
        budget: Number(document.getElementById('dpr-budget').value),
        department: document.getElementById('dpr-dept').value,
        contractor: document.getElementById('dpr-contractor').value,
      };
      
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to submit');
        this.toast('DPR Submitted');
        this.navigate('project', { id: data.project.id });
      } catch (err) {
        this.toast(err.message, true);
      }
    });
  },

  async renderProjectDetail(root, id) {
    const tpl = document.getElementById('tpl-project-detail').content.cloneNode(true);
    root.appendChild(tpl);

    document.getElementById('pd-back').onclick = (e) => { e.preventDefault(); this.navigate('projects'); };

    try {
      const res = await fetch(`/api/projects/${id}?role=${this.role}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      const p = data.project;
      document.getElementById('pd-title').textContent = p.title;
      document.getElementById('pd-code').textContent = p.code;
      document.getElementById('pd-dept').textContent = p.department;
      document.getElementById('pd-budget').textContent = p.budget.toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
      document.getElementById('pd-contractor').textContent = p.contractor || '-';
      
      // Stepper
      const stepper = document.getElementById('pd-stepper');
      this.meta.stage_order.forEach((stageId, idx) => {
        const step = document.createElement('div');
        step.className = 'step';
        if (idx < p.stage_index || p.current_stage === 'PAYMENT_TRIGGERED') step.classList.add('done');
        else if (idx === p.stage_index) {
          step.classList.add('current');
          if (p.overdue) step.classList.add('overdue');
        }
        
        step.innerHTML = `<span class="n">Step ${idx+1}</span><span class="t">${this.meta.stages[stageId].label}</span>`;
        stepper.appendChild(step);
      });

      // Actions
      if (data.available_actions && data.available_actions.length > 0) {
        document.getElementById('pd-actions-container').style.display = 'block';
        document.getElementById('pd-acting-as').textContent = this.meta.roles[this.role].label;
        
        const actionsDiv = document.getElementById('pd-actions');
        let selectedAction = null;
        
        data.available_actions.forEach(a => {
          const btn = document.createElement('button');
          btn.className = 'btn ' + (a.tone || '');
          btn.textContent = a.label;
          btn.onclick = () => {
            selectedAction = a;
            document.getElementById('pd-actions').style.display = 'none';
            document.getElementById('pd-action-form').style.display = 'block';
          };
          actionsDiv.appendChild(btn);
        });

        document.getElementById('pd-action-cancel').onclick = () => {
          selectedAction = null;
          document.getElementById('pd-action-form').style.display = 'none';
          document.getElementById('pd-actions').style.display = 'flex';
          document.getElementById('pd-comment').value = '';
        };

        document.getElementById('pd-action-confirm').onclick = async () => {
          const comment = document.getElementById('pd-comment').value;
          try {
            const res = await fetch(`/api/projects/${id}/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ role: this.role, action: selectedAction.action, comment })
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error);
            this.toast('Action successful');
            this.renderCurrentView(); // reload
          } catch (err) {
            this.toast(err.message, true);
          }
        };
      }

      // Timeline
      const tl = document.getElementById('pd-timeline');
      tl.innerHTML = `<li><div class="meta">Created on ${new Date(p.created_at).toLocaleString()}</div></li>`;
      
      const entries = [...p.approvals, ...p.measurements].sort((a, b) => a.seq - b.seq);
      entries.forEach(e => {
        const li = document.createElement('li');
        if (e.status === 'REJECTED') li.className = 'danger';
        else if (e.status === 'APPROVED' || e.status === 'PAYMENT_TRIGGERED') li.className = 'ok';
        
        let html = `<div class="meta">${new Date(e.timestamp).toLocaleString()} &mdash; ${e.actor_role}</div>`;
        if (e.photo_url) {
          html += `<div><strong>Measurement</strong> uploaded</div>`;
        } else {
          html += `<div><strong>${e.status}</strong> (moved to ${this.meta.stages[e.stage].label})</div>`;
        }
        if (e.comment) {
          html += `<div class="comment">${e.comment}</div>`;
        }
        html += `<div class="mono muted" style="font-size:11px; margin-top:4px" title="Ledger Hash">#${e.seq}: ${e.hash.substring(0,16)}...</div>`;
        
        li.innerHTML = html;
        tl.appendChild(li);
      });

    } catch (e) {
      this.toast('Failed to load project details', true);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => app.init());
