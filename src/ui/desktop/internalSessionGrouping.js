'use strict';

function groupInternalSessions(internal, filter) {
  if (filter !== 'all' && filter !== 'internal') {
    return { pinned: [], recents: [], customSections: [] };
  }
  const active = internal.filter(session => !session.archived);
  const pinned = active.filter(session => session.pinned === true);
  const unpinned = active.filter(session => session.pinned !== true);
  return {
    pinned,
    recents: unpinned.filter(session => session.section === 'recents'),
    customSections: [...new Set(unpinned.map(session => session.section).filter(section => section && section !== 'recents'))]
      .map(section => ({ section, sessions: unpinned.filter(session => session.section === section) }))
  };
}

const internalSessionGrouping = { groupInternalSessions };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = internalSessionGrouping;
}

if (typeof window !== 'undefined') {
  window.internalSessionGrouping = internalSessionGrouping;
}
