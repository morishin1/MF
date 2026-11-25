// Open the requested applicant section without toggling an already-open accordion closed.
export async function openHrSection(page,key){
  const section=page.locator('#hr-section-'+key);
  if(await section.count()){
    if(await section.getAttribute('open')===null)await page.locator('#hr-tab-'+key).click();
    await page.locator('#hr-panel-'+key).waitFor({state:'visible'});
  }else await page.locator('#hr-tab-'+key).click();
}
