export type ResourceType = "image" | "video" | "raw";
export type UploadResourceHint = "auto" | "image" | "video";

export interface UploadSource {
  path?: string;
  url?: string;
}

export interface UploadOptions {
  resourceType?: UploadResourceHint;
  folder?: string;
  publicId?: string;
  overwrite?: boolean;
  tags?: string[];
}

export interface UploadResult {
  provider: string;
  publicId: string;
  secureUrl: string;
  resourceType: ResourceType;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt?: string;
}

export interface LinkOptions {
  resourceType?: ResourceType;
  transformation?: string;
  version?: string | number;
}

export interface ListAssetsOptions {
  resourceType?: ResourceType;
  maxResults?: number;
  nextCursor?: string;
  prefix?: string;
  tags?: string[];
  direction?: "asc" | "desc";
}

export interface ListedAsset {
  publicId: string;
  format?: string;
  resourceType?: ResourceType;
  type?: string;
  bytes?: number;
  width?: number;
  height?: number;
  createdAt?: string;
  url?: string;
  secureUrl?: string;
}

export interface ListAssetsResult {
  resourceType: ResourceType;
  count: number;
  nextCursor?: string;
  assets: ListedAsset[];
}

export interface MediaProvider {
  readonly name: string;
  isConfigured(): boolean;
  upload(source: UploadSource, options?: UploadOptions): Promise<UploadResult>;
  link(publicId: string, options?: LinkOptions): string;
  variants(publicId: string, resourceType?: ResourceType): Record<string, string>;
  listAssets(options?: ListAssetsOptions): Promise<ListAssetsResult>;
  remove(publicId: string, resourceType?: ResourceType): Promise<void>;
}

export interface ProviderCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}
