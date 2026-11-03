'use strict';

const INTERNAL_SESSION_DRAG_TYPE = 'application/x-only-chat-session';

function hasInternalSessionDragType(dataTransfer) {
  try {
    return Array.from(dataTransfer?.types || []).includes(INTERNAL_SESSION_DRAG_TYPE);
  } catch (_) {
    return false;
  }
}

function createSessionMetadataGuard() {
  const pending = new Set();
  return {
    begin(sessionId) {
      if (pending.has(sessionId)) return false;
      pending.add(sessionId);
      return true;
    },
    end(sessionId) { pending.delete(sessionId); }
  };
}

function mapSessionDropDestination(destination) {
  if (!destination || typeof destination !== 'object') return null;
  if (destination.type === 'pinned') return { action: 'pin', payload: { pinned: true } };
  if (destination.type === 'recents') return { action: 'move', payload: { section: 'recents', pinned: false } };
  if (destination.type === 'section' && typeof destination.section === 'string'
    && /^[\p{L}\p{N} _-]{1,32}$/u.test(destination.section.trim())
    && destination.section.trim() !== 'recents') {
    return { action: 'move', payload: { section: destination.section.trim(), pinned: false } };
  }
  return null;
}

const sessionDropMapping = { hasInternalSessionDragType, createSessionMetadataGuard, mapSessionDropDestination };
if (typeof module !== 'undefined' && module.exports) module.exports = sessionDropMapping;
if (typeof window !== 'undefined') window.sessionDropMapping = sessionDropMapping;
