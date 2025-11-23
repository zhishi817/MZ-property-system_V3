import { Card, Row, Col, Statistic } from 'antd'

export default function DashboardPage() {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} sm={12} lg={6}><Card><Statistic title="房源数" value={100} /></Card></Col>
      <Col xs={24} sm={12} lg={6}><Card><Statistic title="当日退房" value={8} /></Card></Col>
      <Col xs={24} sm={12} lg={6}><Card><Statistic title="清洁任务" value={12} /></Card></Col>
      <Col xs={24} sm={12} lg={6}><Card><Statistic title="在住订单" value={34} /></Card></Col>
    </Row>
  )
}