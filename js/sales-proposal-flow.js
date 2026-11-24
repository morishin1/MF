(function(){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.SalesProposalFlow={html(flow) {
    if(!Array.isArray(flow) || flow.length!==5) return '<small class="spf-unavailable">工程の記録を確認できません</small>';
    return '<ol class="spf-steps" aria-label="提案の進捗">'+flow.map(s=>
      '<li class="spf-'+(['done','pending','stopped'].includes(s.state)?s.state:'unknown')+'"><span>'+esc(s.label)+'</span><b>'+esc(s.value)+'</b></li>').join('')+'</ol>';
  }};
})();
