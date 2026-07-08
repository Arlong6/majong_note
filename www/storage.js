(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongStorage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const K = { rec: 'mahjong_records', ply: 'mahjong_players', onb: 'mahjong_onboarded', mig: 'migrated_v1' };
  const DEFAULT_PLAYERS = ['阿明', '小華', '大強', '林小姐'];

  function createStorage(a) {
    async function load() { return { records: [], players: DEFAULT_PLAYERS, onboarded: false, source: 'empty' }; }
    async function save() {}
    async function writeBackup() {}
    return { load, save, writeBackup, _K: K };
  }
  return { createStorage };
});
