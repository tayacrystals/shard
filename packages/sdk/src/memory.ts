export interface StoredMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface Entity {
  id: string;
  name: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  timestamp: Date;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  threshold?: number;
  channelId?: string;
  before?: Date;
  after?: Date;
}

export interface SearchResult {
  message: StoredMessage;
  score: number;
}

export interface MemoryService {
  storeMessage(message: StoredMessage): Promise<void>;
  getMessages(channelId: string, limit?: number): Promise<StoredMessage[]>;
  search(options: SearchOptions): Promise<SearchResult[]>;

  storeEntity(entity: Entity): Promise<void>;
  getEntity(id: string): Promise<Entity | undefined>;

  storeFact(fact: Fact): Promise<void>;
  getFacts(subject: string): Promise<Fact[]>;
}
