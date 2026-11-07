export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Member extends User {
  role?: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description: string;
  taskCount?: number;
  doneCount?: number;
}

export interface Column {
  id: string;
  projectId: string;
  name: string;
  position: number;
  isDone: boolean;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  projectId: string;
  columnId: string;
  number: number;
  title: string;
  description: string;
  priority: Priority;
  assigneeId: string | null;
  dueDate: string | null;
  estimate: number | null;
  position: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  labelIds: string[];
  commentCount: number;
}

export interface Board {
  project: ProjectSummary;
  columns: Column[];
  tasks: Task[];
  labels: Label[];
  members: User[];
}

export interface Comment {
  id: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  actorId: string | null;
  verb: string;
  detail: string;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  activity: ActivityItem[];
  subtasks: Array<{ id: string; title: string; columnId: string }>;
}
