/**
 * The parts of ClickUp API v2/v3 responses the kit uses. Fields are optional where ClickUp
 * may leave them out; unknown fields are kept but not typed.
 */

export interface ClickUpUser {
  id: number;
  username: string | null;
  email?: string | null;
}

export interface ClickUpStatus {
  id?: string;
  status: string;
  /** "open", "custom", "done" or "closed". */
  type?: string | null;
  orderindex?: number;
  color?: string;
}

export interface ClickUpTask {
  id: string;
  custom_id?: string | null;
  name: string;
  status?: ClickUpStatus;
  url?: string;
  list?: { id: string; name?: string };
  parent?: string | null;
  assignees?: ClickUpUser[];
  priority?: { priority?: string } | null;
  due_date?: string | null;
  date_updated?: string | null;
  tags?: { name: string }[];
  description?: string;
  text_content?: string;
  markdown_description?: string;
  subtasks?: ClickUpTask[];
}

export interface ClickUpComment {
  id: string;
  /** Unix ms, as a string. */
  date: string;
  comment_text?: string;
  user?: ClickUpUser;
}

export interface ClickUpList {
  id: string;
  name: string;
  statuses?: ClickUpStatus[];
}

export interface ClickUpTeam {
  id: string;
  name: string;
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
  lists?: ClickUpList[];
}

export interface ClickUpDocPage {
  id: string;
  name?: string;
  title?: string;
  content?: string;
  pages?: ClickUpDocPage[];
}
