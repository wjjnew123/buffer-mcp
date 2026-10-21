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

export interface MediaProvider {
  readonly name: string;
  isConfigured(): boolean;
  upload(source: UploadSource, options?: UploadOptions): Promise<UploadResult>;
  link(publicId: string, options?: LinkOptions): string;
  variants(publicId: string, resourceType?: ResourceType): Record<string, string>;
  remove(publicId: string, resourceType?: ResourceType): Promise<void>;
}

export interface ProviderCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}
