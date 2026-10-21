const CHANNEL_FIELDS = `
  id
  name
  displayName
  service
  type
  descriptor
  organizationId
  timezone
  avatar
  serviceId
  isDisconnected
  isLocked
  isQueuePaused
  hasActiveMemberDevice
  createdAt
  updatedAt
`;

const POST_FIELDS = `
  id
  text
  status
  dueAt
  sentAt
  createdAt
  updatedAt
  channelId
  channelService
  schedulingType
  isCustomScheduled
  externalLink
  error { message rawError supportUrl }
  assets {
    __typename
    id
    source
    thumbnail
    mimeType
    ... on ImageAsset { image { width height altText } }
    ... on VideoAsset { video { width height durationMs title } }
    ... on DocumentAsset { document { title numPages } }
  }
`;

export const ORGANIZATIONS = `
query Organizations {
  account {
    id
    email
    name
    timezone
    organizations {
      id
      name
      channelCount
      limits { channels scheduledPosts members ideas ideaGroups }
    }
  }
}
`;

export const CHANNELS = `
query Channels($input: ChannelsInput!) {
  channels(input: $input) {
    ${CHANNEL_FIELDS}
  }
}
`;

export const CHANNEL = `
query Channel($input: ChannelInput!) {
  channel(input: $input) {
    ${CHANNEL_FIELDS}
  }
}
`;

export const POSTS = `
query Posts($input: PostsInput!, $first: Int, $after: String) {
  posts(input: $input, first: $first, after: $after) {
    edges {
      cursor
      node { ${POST_FIELDS} }
    }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}
`;

export const POST = `
query Post($input: PostInput!) {
  post(input: $input) { ${POST_FIELDS} }
}
`;

export const DAILY_LIMITS = `
query DailyLimits($input: DailyPostingLimitsInput!) {
  dailyPostingLimits(input: $input) {
    channelId
    isAtLimit
    limit
    scheduled
    sent
  }
}
`;

export const AGGREGATED_METRICS = `
query AggregatedMetrics($input: AggregatedPostMetricsInput!) {
  aggregatedPostMetrics(input: $input) {
    metricsUpdatedAt
    metrics { name description type unit value }
  }
}
`;

export const IDEA_GROUPS = `
query IdeaGroups($input: IdeaGroupsInput!) {
  ideaGroups(input: $input) { id name isLocked }
}
`;

export const IDEAS = `
query Ideas($input: IdeasInput!, $first: Int, $after: String) {
  ideas(input: $input, first: $first, after: $after) {
    edges {
      cursor
      node {
        id
        groupId
        organizationId
        position
        createdAt
        updatedAt
        content { title text date services aiAssisted }
      }
    }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}
`;

export const CREATE_IDEA = `
mutation CreateIdea($input: CreateIdeaInput!) {
  createIdea(input: $input) {
    __typename
    ... on Idea { id groupId organizationId content { title text services } }
    ... on MutationError { message }
  }
}
`;

export const CREATE_POST = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt channelId text } }
    ... on MutationError { message }
  }
}
`;

export const EDIT_POST = `
mutation EditPost($input: EditPostInput!) {
  editPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt channelId text } }
    ... on MutationError { message }
  }
}
`;

export const DELETE_POST = `
mutation DeletePost($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on DeletePostSuccess { id }
    ... on MutationError { message }
  }
}
`;
