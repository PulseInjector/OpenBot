/** The permissions shown by a Bot creation confirmation, included in its request fingerprint. */
export type BotCreationConfirmation = {
  skills: string[];
  apps: { app: string; refs: string[] }[];
};
