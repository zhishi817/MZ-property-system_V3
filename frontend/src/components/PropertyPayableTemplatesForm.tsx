"use client"

import { Button, Card, Col, DatePicker, Divider, Form, Input, InputNumber, Row, Select, Space } from 'antd'
import dayjs from 'dayjs'
import {
  PROPERTY_PAYABLE_CATEGORY_OPTIONS,
  PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH,
  PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS,
  defaultPropertyPayableTemplate,
} from '../lib/propertyPayables'
import PropertyPayableVendorInput from './PropertyPayableVendorInput'

function PaymentFields(props: { fieldName: string; index: number }) {
  return (
    <Form.Item
      noStyle
      shouldUpdate={(prev, cur) => prev?.[props.fieldName]?.[props.index]?.payment_type !== cur?.[props.fieldName]?.[props.index]?.payment_type}
    >
      {(form) => {
        const paymentType = form.getFieldValue([props.fieldName, props.index, 'payment_type']) || 'bank_account'
        if (paymentType === 'bank_account') {
          return (
            <>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_account_name']} label="收款方">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_bsb']} label="BSB">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_account_number']} label="Account No.">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_ref']} label="付款 Reference">
                  <Input />
                </Form.Item>
              </Col>
            </>
          )
        }
        if (paymentType === 'bpay') {
          return (
            <>
              <Col span={8}>
                <Form.Item name={[props.index, 'bpay_code']} label="BPAY Code">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_ref']} label="付款 Reference">
                  <Input />
                </Form.Item>
              </Col>
            </>
          )
        }
        if (paymentType === 'payid') {
          return (
            <>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_account_name']} label="收款方">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_mobile_number']} label="PayID 手机号">
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name={[props.index, 'pay_ref']} label="付款 Reference">
                  <Input />
                </Form.Item>
              </Col>
            </>
          )
        }
        if (paymentType === 'cash') {
          return (
            <Col span={24}>
              <Card size="small">现金付款无需填写收款账户信息。</Card>
            </Col>
          )
        }
        if (paymentType === 'rent_deduction') {
          return (
            <Col span={24}>
              <Card size="small">租金扣除无需填写银行或 BPAY 信息。</Card>
            </Col>
          )
        }
        return null
      }}
    </Form.Item>
  )
}

export default function PropertyPayableTemplatesForm(props: { form: any; name?: string; title?: string }) {
  const fieldName = props.name || 'payable_templates'
  return (
    <>
      <Divider orientation="left">{props.title || '房源代付模板预设'}</Divider>
      <Form.List name={fieldName}>
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {fields.map((field, index) => (
              <Card
                key={field.key}
                size="small"
                title={`代付模板 ${index + 1}`}
                extra={<Button danger type="link" onClick={() => remove(field.name)}>删除</Button>}
              >
                <Row gutter={[16, 12]}>
                  <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                  <Col span={8}>
                  <Form.Item name={[field.name, 'vendor']} label="收费公司/事项" rules={[{ required: true, message: '必填' }]}>
                      <PropertyPayableVendorInput />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'category']} label="类别" rules={[{ required: true, message: '必填' }]}>
                      <Select options={PROPERTY_PAYABLE_CATEGORY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'amount']} label="默认金额">
                      <InputNumber min={0} step={1} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'bill_account_no']} label="Account Number">
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'start_month_key']} label="起始月份" rules={[{ required: true, message: '请选择起始月份' }]}>
                      <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'bill_expected_day_of_month']} label="预计收到账单日" rules={[{ required: true, message: '必填' }]}>
                      <InputNumber min={1} max={31} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="付款截止日">
                      <Input value={`每月 ${PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH} 号`} disabled />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name={[field.name, 'payment_type']} label="付款方式" initialValue="bank_account">
                      <Select options={PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
                    </Form.Item>
                  </Col>
                  <PaymentFields fieldName={fieldName} index={field.name} />
                  <Col span={24}>
                    <Form.Item name={[field.name, 'note']} label="模板备注">
                      <Input.TextArea rows={2} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>
            ))}
            <Button
              type="dashed"
              block
              onClick={() => add({ ...defaultPropertyPayableTemplate(), start_month_key: dayjs() })}
            >
              新增代付模板
            </Button>
          </Space>
        )}
      </Form.List>
    </>
  )
}
