export function zhToEn(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[\x00-\x7F]+$/.test(s)) return s
  const EXACT: Record<string, string> = {
    '毛毯':'Blanket','床垫保护套':'Mattress Protector','枕头':'Pillow','灯泡':'Light Bulb','E27灯泡':'E27 Bulb','E14灯泡':'E14 Bulb','衣架':'Hangers','杯子':'Cup','咖啡机':'Coffee Machine','烘干机':'Dryer','洗衣机':'Washing Machine','沙发':'Sofa','茶几':'Coffee Table','床':'Bed','马桶刷':'Toilet Brush','吹风机':'Hair Dryer','沐浴露':'Body Wash','洗手液':'Hand Wash','砧板':'Cutting Board','平台上线费':'Platform Onboarding Fee','床头':'Bedside Table','床头灯':'Bedside Lamp','面包机':'Bread Maker','烧水壶':'Kettle','电热水壶':'Electric Kettle','装饰花':'Decorative Flowers','厨房装饰花':'Kitchen Decorative Flowers','被子':'Duvet','衣柜':'Wardrobe','晾衣架':'Clothes Rack','晾衣杆':'Clothes Rail','垃圾桶':'Trash Bin','餐桌':'Dining Table','餐椅':'Dining Chair','窗帘':'Curtains','床单':'Bedsheet','人工安装费':'Installation Labour','第一次清洁&床品费':'First Cleaning & Bedding Fee','拍照费':'Photography Fee','量勺':'Measuring Spoons','压蒜器':'Garlic Press','沙拉碗':'Salad Bowl','漏网':'Strainer','打蛋器':'Whisk','锅铲':'Spatula','食物夹':'Tongs','削皮刀':'Peeler','开罐器':'Can Opener','漏勺':'Skimmer','盐罐':'Salt Container','土豆压泥器':'Potato Masher','粘毛桶':'Lint Roller','防滑垫':'Non-slip Mat','茶咖啡糖罐':'Tea, Coffee & Sugar Canisters','粘毛桶备用卷':'Lint Roller Refill','刀叉勺':'Cutlery Set','剪子':'Kitchen Scissors','剪刀':'Scissors','烤箱手套':'Oven Mitts','炒菜勺':'Spatula','喝水杯':'Water Glass','咖啡杯':'Coffee Mug','碗碟':'Dinnerware','锅':'Pot','红酒杯':'Wine Glass','糖罐':'Sugar Container','吸尘器':'Vacuum Cleaner','灭火器':'Fire Extinguisher','洗衣粉收纳盒':'Laundry Powder Storage Box','拖把头':'Mop Head','簸箕':'Dustpan','门阻':'Door Stopper','拖把杆':'Mop Handle','婴儿床':'Baby Cot','婴儿椅':'High Chair','厨房收纳盒':'Kitchen Storage Box','急救包':'First Aid Kit','晾斗':'Laundry Basket','熨斗':'Iron','熨衣板':'Ironing Board','洗手液瓶':'Soap Dispenser'
  }
  if (EXACT[s]) return EXACT[s]
  const TOKENS: Array<[RegExp,string]> = [
    [/客厅装饰花/g,'Living Room Decorative Flowers'],[/餐厅装饰花/g,'Dining Decorative Flowers'],[/餐桌装饰花/g,'Dining Table Decorative Flowers'],[/卧室装饰花/g,'Bedroom Decorative Flowers'],[/走廊装饰花|玄关装饰花/g,'Hallway Decorative Flowers'],
    [/客厅装饰画/g,'Living Room Wall Art'],[/餐厅装饰画/g,'Dining Wall Art'],[/餐桌装饰画/g,'Dining Table Wall Art'],[/卧室装饰画/g,'Bedroom Wall Art'],[/走廊装饰画|玄关装饰画/g,'Hallway Wall Art'],
    [/咖啡机/g,'Coffee Machine'],[/面包机/g,'Bread Maker'],[/烧水壶|热水壶/g,'Kettle'],[/刀叉勺/g,'Cutlery Set'],[/红酒杯/g,'Wine Glass'],[/垃圾桶/g,'Trash Bin'],[/糖罐/g,'Sugar Container'],[/盐罐/g,'Salt Container'],[/开罐器/g,'Can Opener'],[/削皮刀/g,'Peeler'],[/打蛋器/g,'Whisk'],[/漏网/g,'Strainer'],[/锅铲|炒菜勺/g,'Spatula'],[/食物夹/g,'Tongs'],[/量勺/g,'Measuring Spoons'],[/碗碟/g,'Dinnerware'],[/碗/g,'Bowl'],[/杯子/g,'Cup'],[/杯/g,'Cup'],[/锅/g,'Pot'],[/洗手液瓶/g,'Soap Dispenser'],[/熨衣板|熨斗板/g,'Ironing Board'],[/熨斗/g,'Iron'],[/茶咖啡糖罐/g,'Tea, Coffee & Sugar Canisters'],[/装饰画/g,'Wall Art'],[/装饰花/g,'Decorative Flowers']
  ]
  let out = s
  for (const [re, en] of TOKENS) { out = out.replace(re, en) }
  out = out.replace(/\s+/g,' ').trim()
  // If still contains CJK, return original to avoid misleading output
  return /[\u4E00-\u9FFF]/.test(out) ? s : out
}
