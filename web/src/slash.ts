// Notion-style "/" commands for the editor. CARET in a snippet marks where the caret goes.
import { CARET as C } from './editor';
export interface Slash { label: string; keywords: string; snippet: () => string }

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const time = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export const SLASH: Slash[] = [
  { label: 'Заголовок 1', keywords: 'h1 heading title', snippet: () => '# ' + C },
  { label: 'Заголовок 2', keywords: 'h2 heading', snippet: () => '## ' + C },
  { label: 'Заголовок 3', keywords: 'h3 heading', snippet: () => '### ' + C },
  { label: 'Список', keywords: 'bullet list маркований', snippet: () => '- ' + C },
  { label: 'Нумерований список', keywords: 'numbered ordered list', snippet: () => '1. ' + C },
  { label: 'Завдання', keywords: 'todo task checkbox чекбокс', snippet: () => '- [ ] ' + C },
  { label: 'Посилання на нотатку', keywords: 'link wikilink', snippet: () => '[[' + C + ']]' },
  { label: 'Вбудувати нотатку', keywords: 'embed transclude', snippet: () => '![[' + C + ']]' },
  { label: 'Цитата', keywords: 'quote blockquote', snippet: () => '> ' + C },
  { label: 'Виноска', keywords: 'callout note info', snippet: () => '> **Примітка:** ' + C },
  { label: 'Код', keywords: 'code block fence', snippet: () => '```\n' + C + '\n```' },
  { label: 'Таблиця', keywords: 'table', snippet: () => '| Колонка 1 | Колонка 2 |\n| --- | --- |\n| ' + C + ' |  |' },
  { label: 'Розділювач', keywords: 'divider hr line', snippet: () => '---\n' + C },
  { label: 'Дата', keywords: 'date today сьогодні', snippet: () => today() + C },
  { label: 'Час', keywords: 'time now зараз', snippet: () => time() + C },
  { label: 'Дата і час', keywords: 'datetime timestamp', snippet: () => `${today()} ${time()}${C}` },
  { label: 'Жирний', keywords: 'bold strong', snippet: () => '**' + C + '**' },
  { label: 'Курсив', keywords: 'italic emphasis', snippet: () => '*' + C + '*' },
  { label: 'Закреслений', keywords: 'strike', snippet: () => '~~' + C + '~~' },
];
