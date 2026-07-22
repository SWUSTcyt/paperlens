export interface MineruLocalSettings {
  enabled: boolean;
  port: number;
  accessToken: string;
}

export function normalizeMineruSettings(
  value?: Partial<MineruLocalSettings>,
): MineruLocalSettings {
  const candidatePort = value?.port;
  const port = Number.isInteger(candidatePort) && candidatePort! >= 1024 && candidatePort! <= 65535
    ? candidatePort!
    : 17860;
  return {
    enabled: value?.enabled === true,
    port,
    accessToken: typeof value?.accessToken === 'string' ? value.accessToken : '',
  };
}
