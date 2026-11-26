'use strict';
// The only bridge between the window and the rest of the app.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('photobot', {
  query: invoke('library:query'),
  years: invoke('library:years'),
  stats: invoke('library:stats'),
  item: invoke('item:get'),
  setFav: invoke('items:setFav'),
  rotate: invoke('item:rotate'),
  addTag: invoke('items:addTag'),
  removeTag: invoke('item:removeTag'),
  addPerson: invoke('items:addPerson'),
  removePerson: invoke('item:removePerson'),
  renamePerson: invoke('person:rename'),
  showInFolder: invoke('item:showInFolder'),
  openExternal: invoke('item:openExternal'),
  trash: invoke('items:trash'),
  people: invoke('browse:people'),
  places: invoke('browse:places'),
  tags: invoke('browse:tags'),
  cameras: invoke('browse:cameras'),
  suggest: invoke('search:suggest'),
  folders: invoke('folders:list'),
  addFolders: invoke('folders:add'),
  removeFolder: invoke('folders:remove'),
  rescan: invoke('folders:rescan'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  info: invoke('app:info'),
  openDataDir: invoke('app:openDataDir'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => {
    if (!['scan:progress', 'library:changed'].includes(channel)) return () => {};
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
