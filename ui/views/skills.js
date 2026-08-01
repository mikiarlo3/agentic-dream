import { api, el } from '../api.js';

export async function skillsView(view) {
  const skills = await api('/api/skills');
  view.replaceChildren(
    el('h2', {}, 'Skills'),
    el('p', { class: 'sub' }, 'Procedures promoted after repeated clean successes — installed behavior that costs zero recall tokens.'),
    skills.length === 0
      ? el('p', { class: 'empty' }, 'Nothing promoted yet. A procedure needs 5 clean successes to graduate.')
      : skills.map((s) =>
          el('div', { class: 'panel' },
            el('h3', { class: 'mono' }, `${s.name}.md`),
            el('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:0' }, s.markdown),
          ),
        ),
  );
}
