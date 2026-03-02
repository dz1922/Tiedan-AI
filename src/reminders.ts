/**
 * Family reminders - Outlook To Do integration
 */
import { readFileSync } from 'fs';

const CREDS_FILE = process.env.OUTLOOK_CREDS || '/root/.openclaw/workspace/.credentials/outlook-calendar.json';

interface Credentials { client_id: string; client_secret: string; refresh_token: string; }

let _credentials: Credentials | null = null;
function getCredentials(): Credentials {
  if (!_credentials) _credentials = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  return _credentials!;
}

async function getAccessToken(): Promise<string> {
  const creds = getCredentials();
  const params = new URLSearchParams({
    client_id: creds.client_id, client_secret: creds.client_secret,
    refresh_token: creds.refresh_token, grant_type: 'refresh_token',
    scope: 'Calendars.ReadWrite Tasks.ReadWrite offline_access'
  });
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', body: params });
  const data = await res.json() as any;
  if (!data.access_token) throw new Error('Failed to get access token');
  return data.access_token;
}

async function getFamilyListId(token: string): Promise<string> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json() as any;
  const familyList = data.value?.find((l: any) => l.displayName === 'Family');
  if (familyList) return familyList.id;

  const createRes = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Family' })
  });
  const created = await createRes.json() as any;
  return created.id;
}

export async function getTodayReminders() {
  const token = await getAccessToken();
  const listId = await getFamilyListId(token);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks?$filter=status ne 'completed'&$orderby=dueDateTime/dateTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as any;
  const today = new Date().toISOString().slice(0, 10);
  const tasks = (data.value || []).map((t: any) => ({
    id: t.id, title: t.title, due: t.dueDateTime?.dateTime?.slice(0, 10),
    reminder: t.reminderDateTime?.dateTime, status: t.status
  }));
  return { today: tasks.filter((t: any) => t.due === today), upcoming: tasks.filter((t: any) => t.due !== today) };
}

export async function createFamilyReminder(title: string, dueDate: string, reminderTime?: string) {
  const token = await getAccessToken();
  const listId = await getFamilyListId(token);
  const body: any = {
    title,
    dueDateTime: { dateTime: `${dueDate}T00:00:00`, timeZone: 'UTC' },
    isReminderOn: !!reminderTime
  };
  if (reminderTime) body.reminderDateTime = { dateTime: reminderTime, timeZone: 'UTC' };

  const res = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}
