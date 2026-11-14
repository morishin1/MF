(function(root){
 const tabs=[['mypage','基本情報','/mypage.html'],['contracts','契約書','/contracts.html'],['submissions','提出書類','/submissions.html']];
 function mount(active){
  const wrap=document.querySelector('.wrap'),head=wrap?.querySelector('h1');if(!head)return;
  wrap.querySelectorAll('.kp-subnav,.member-page-links').forEach(n=>n.remove());
  const nav=document.createElement('nav');nav.className='kp-subnav';nav.setAttribute('aria-label','マイページ');
  for(const [key,label,href]of tabs){const link=document.createElement(key===active?'span':'a');link.className='kp-subtab'+(key===active?' on':'');link.textContent=label;if(key===active)link.setAttribute('aria-current','page');else link.href=href;nav.append(link);}
  head.after(nav);
 }
 root.MemberPortalNav={mount};
})(globalThis);
